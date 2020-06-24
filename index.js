'use strict';

const _ = require('underscore');
const SonosListener = require('sonos/lib/events/adv-listener');
const sonos = require('sonos');
const Sonos = require('sonos').Sonos;

var Service;
var Characteristic;

var sonosDevices = new Map();
var sonosAccessories = [];

function getZoneGroupCoordinator (zone) {
  var coordinator;
  sonosDevices.forEach(function (device) {
    if (device.CurrentZoneName == zone && device.coordinator == 'true') {
      coordinator = device;
    }
  });
  if (coordinator == undefined) {
    var zoneGroups = getZoneGroupNames(zone);
    zoneGroups.forEach(function (group) {
      sonosDevices.forEach(function (device) {
        if (device.group == group && device.coordinator == 'true') {
          coordinator = device;
        }
      });
    });
  }
  return coordinator;
}

function getZoneGroupNames (zone) {
  var groups = [];
  sonosDevices.forEach(function (device) {
    if (device.CurrentZoneName == zone) {
      groups.push(device.group);
    }
  });
  return groups;
}

function listenGroupMgmtEvents (device) {
  var devListener = new SonosListener(device);
  devListener.listen(function (listenErr) {
    if (!listenErr) {
      devListener.addService('/GroupManagement/Event', function (addServErr, sid) {
        if (!addServErr) {
          devListener.on('serviceEvent', function (endpoint, sid, data) {
            sonosDevices.forEach(function (devData) {
              var dev = new Sonos(devData.ip);
              dev.getZoneAttrs(function (err, zoneAttrs) {
                if (!err && zoneAttrs) {
                  device.getTopology(function (err, topology) {
                    if (!err && topology) {
                      var bChangeDetected = false;
                      topology.zones.forEach(function (group) {
                        if (group.location == 'http://' + devData.ip + ':' + devData.port + '/xml/device_description.xml') {
                          if (zoneAttrs.CurrentZoneName != devData.CurrentZoneName) {
                            devData.CurrentZoneName = zoneAttrs.CurrentZoneName;
                          }
                          if (group.coordinator != devData.coordinator || group.group != devData.group) {
                            devData.coordinator = group.coordinator;
                            devData.group = group.group;
                            bChangeDetected = true;
                          }
                        }
                        else {
                          var grpDevIP = group.location.substring(7, group.location.lastIndexOf(":"));
                          var grpDevData = sonosDevices.get(grpDevIP);
                          if (grpDevData != undefined) {
                            if (group.name != grpDevData.CurrentZoneName) {
                              grpDevData.CurrentZoneName = group.Name;
                            }
                            if (group.coordinator != grpDevData.coordinator || group.group != grpDevData.group) {
                              grpDevData.coordinator = group.coordinator;
                              grpDevData.group = group.group;
                              bChangeDetected = true;
                            }
                          }
                        }
                      });
                      if (bChangeDetected) {
                        sonosAccessories.forEach(function (accessory) {
                          var coordinator = getZoneGroupCoordinator(accessory.room);
                          accessory.log.debug("Target Zone Group Coordinator identified as: %s", JSON.stringify(coordinator));
                          if (coordinator == undefined) {
                            accessory.log.debug("Removing coordinator device from %s", JSON.stringify(accessory.device));
                            accessory.device = coordinator;
                          }
                          else {
                            var bUpdate = false;
                            if (accessory.device != undefined) {
                              if (accessory.device.host != coordinator.ip) {
                                bUpdate = true;
                              }
                            }
                            else {
                              bUpdate = true;
                            }
                            if (bUpdate) {
                              accessory.log("Changing coordinator device from %s to %s (from sonos zone %s) for accessory '%s' in accessory room '%s'.", accessory.device.host, coordinator.ip, coordinator.CurrentZoneName, accessory.name, accessory.room);
                              accessory.device = new Sonos(coordinator.ip);
                            }
                            else {
                              accessory.log.debug("No coordinator device change required!");
                            }
                          }
                        });
                      }
                    }
                  });
                }
              });
            });
          });
        }
      });
    }
  });
}

function SonosAccessory (log, config) {
  this.log = log;
  this.config = config;
  this.name = config["name"];
  this.room = config["room"];
  this.model = config["model"];
  this.serialNumber = config["serial_number"];
  this.firmwareRevision = config["firmware_revision"];
  this.hardwareRevision = config["hardware_revision"];
  this.enableSpeakerService = config["enable_speaker_service"];

  if (!this.room) throw new Error("You must provide a config value for 'room'.");

  this.accessoryInformationService = new Service.AccessoryInformation();

  this.accessoryInformationService
    .setCharacteristic(Characteristic.Manufacturer, "Sonos")
    .setCharacteristic(Characteristic.Model, this.model || "Not Available")
    .setCharacteristic(Characteristic.Name, this.name)
    .setCharacteristic(Characteristic.SerialNumber, this.serialNumber || "Not Available")
    .setCharacteristic(Characteristic.FirmwareRevision, this.firmwareRevision || require('./package.json').version);
  
  if (this.hardwareRevision) {
    this.accessoryInformationService
      .setCharacteristic(Characteristic.HardwareRevision, this.hardwareRevision);
  }

  this.switchService = new Service.Switch(this.name);

  this.switchService
    .getCharacteristic(Characteristic.On)
    .on('get', this.getOn.bind(this))
    .on('set', this.setOn.bind(this));

  this.speakerService = new Service.Speaker(this.name);

  // this.speakerService
  //   .getCharacteristic(Characteristic.Mute)
  //   .on('get', this.getMute.bind(this))
  //   .on('set', this.setMute.bind(this));

  this.speakerService
    .addCharacteristic(Characteristic.Brightness)
    .on('get', this.getVolume.bind(this))
    .on('set', this.setVolume.bind(this));

  this.search();
}

SonosAccessory.zoneTypeIsPlayable = function (zoneType) {
  // 8 is the Sonos SUB, 4 is the Sonos Bridge, 11 is unknown
  return zoneType != '11' && zoneType != '8' && zoneType != '4';
}

SonosAccessory.prototype.search = function () {
  var search = sonos.Search(function (device) {
    var host = device.host;
    this.log.warn("Found Sonos device at %s", host);
    device.deviceDescription().then(function (description) {
      var zoneType = description["zoneType"];
      var roomName = description["roomName"];
      if (!SonosAccessory.zoneTypeIsPlayable(zoneType)) {
        this.log.warn("Sonos device %s is not playable (has an unknown zone type of %s); ignoring", host, zoneType);
        return;
      }
      if (roomName != this.room) {
        this.log.warn("Ignoring device %s because the room name '%s' does not match the desired name '%s'.", host, roomName, this.room);
        return;
      }
      this.log.warn("Found a playable device at %s for room '%s'", host, roomName);
      this.device = device;
      search.socket.close();
    }.bind(this));
  }.bind(this));
}

SonosAccessory.prototype.getServices = function () {
  if (this.enableSpeakerService) {
    return [this.accessoryInformationService, this.switchService, this.speakerService];
  }
  return [this.accessoryInformationService, this.switchService];
}

SonosAccessory.prototype.getOn = function (callback) {
  if (!this.device) {
    this.log.warn("Ignoring request; Sonos device has not yet been discovered.");
    callback(new Error("Sonos has not been discovered yet."));
    return;
  }
  this.device.getCurrentState().then(function (state) {
      this.log("Current state: %s", state);
      var on = (state === "playing");
      callback(null, on);
  }.bind(this));
}

SonosAccessory.prototype.setOn = function (on, callback) {
  if (!this.device) {
    this.log.warn("Ignoring request; Sonos device has not yet been discovered.");
    callback(new Error("Sonos has not been discovered yet."));
    return;
  }
  this.log("Setting power to: %s", on);
  if (on) {
    this.device.play().then(function (success) {
        callback(null);
    }.bind(this));
  }
  else {
    this.device.pause().then(function (success) {
        callback(null);
    }.bind(this));
  }
}

SonosAccessory.prototype.getMute = function (callback) {
  if (!this.device) {
    this.log.warn("Ignoring request; Sonos device has not yet been discovered.");
    callback(new Error("Sonos has not been discovered yet."));
    return;
  }
  this.device.getMuted().then(function (state) {
      this.log("Current mute state: %s", state);
      callback(null, state);
  }.bind(this));
}

SonosAccessory.prototype.setMute = function (mute, callback) {
  if (!this.device) {
    this.log.warn("Ignoring request; Sonos device has not yet been discovered.");
    callback(new Error("Sonos has not been discovered yet."));
    return;
  }
  this.log("Setting mute to: %s", mute);
  this.device.setMuted(mute).then(function () {
      callback(null);
  }.bind(this));
}

SonosAccessory.prototype.getVolume = function (callback) {
  if (!this.device) {
    this.log.warn("Ignoring request; Sonos device has not yet been discovered.");
    callback(new Error("Sonos has not been discovered yet."));
    return;
  }
  this.device.getVolume().then(function (volume) {
      this.log("Current volume: %s%", volume);
      callback(null, Number(volume));
  }.bind(this));
}

SonosAccessory.prototype.setVolume = function (volume, callback) {
  if (!this.device) {
    this.log.warn("Ignoring request; Sonos device has not yet been discovered.");
    callback(new Error("Sonos has not been discovered yet."));
    return;
  }
  this.log("Setting volume to: %s%", volume);
  this.device.setVolume(volume).then(function (data) {
      callback(null);
  }.bind(this));
}

module.exports = function (homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  homebridge.registerAccessory("homebridge-sonos-schmittx", "Sonos", SonosAccessory);
}