'use strict';

const axios = require('axios').default;
const fs = require('fs');
const path = require('path');

const PLUGIN_NAME = 'homebridge-meraki-control';
const PLATFORM_NAME = 'Meraki';

let Accessory, Characteristic, Service, Categories, UUID;

module.exports = (api) => {
  Accessory = api.platformAccessory;
  Characteristic = api.hap.Characteristic;
  Service = api.hap.Service;
  Categories = api.hap.Categories;
  UUID = api.hap.uuid;
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, merakiPlatform, true);
}

class merakiPlatform {
  constructor(log, config, api) {
    // only load if configured
    if (!config || !Array.isArray(config.devices)) {
      log('No configuration found for %s', PLUGIN_NAME);
      return;
    }
    this.log = log;
    this.config = config;
    this.api = api;
    this.devices = config.devices || [];

    this.api.on('didFinishLaunching', () => {
      this.log.debug('didFinishLaunching');
      for (let i = 0, len = this.devices.length; i < len; i++) {
        let device = this.devices[i];
        if (!device.name) {
          this.log.warn('Device Name Missing');
        } else {
          new merakiDevice(this.log, device, this.api);
        }
      }
    });

  }

  configureAccessory(platformAccessory) {
    this.log.debug('configurePlatformAccessory');
  }

  removeAccessory(platformAccessory) {
    this.log.debug('removePlatformAccessory');
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [platformAccessory]);
  }
}

class merakiDevice {
  constructor(log, config, api) {
    this.log = log;
    this.api = api;
    this.config = config;


    //network configuration
    this.name = config.name;
    this.host = config.host;
    this.apiKey = config.apiKey;
    this.organizationId = config.organizationId;
    this.networkId = config.networkId;
    this.type = config.type || "wlanControl";
    this.refreshInterval = config.refreshInterval || 10;

    //get Device info
    this.manufacturer = config.manufacturer || 'Cisco Meraki';
    this.modelName = config.modelName || '-';
    this.serialNumber = config.serial || '-';
    this.firmwareRevision = config.firmwareRevision || '-';

    //setup variables
    this.checkDeviceState = false;
    this.wlanLength = 0;
    this.wlanState = [];
    this.prefDir = path.join(api.user.storagePath(), 'meraki');
    this.productTypeUrl = this.host + '/api/v1/networks/' + this.networkId;
    this.mxUrl = this.host + '/api/v1/networks/' + this.networkId + '/appliance/ports';
    this.mrUrl = this.host + '/api/v1/networks/' + this.networkId + '/wireless/ssids';
    this.msUrl = this.host + '/api/v1/devices/' + this.serialNumber + '/switch/ports';
    this.mvUrl = this.host + '/api/v1/devices/' + this.serialNumber + '/camera';
    this.mtUrl = this.host + '/api/v1/devices/' + this.networkId + '/sensors';
    this.mtStatsUrl = this.host + '/api/v1/networks/' + this.networkId + '/sensors/stats/latestBySensor';
    this.devicesUrl = this.host + '/api/v1/networks/' + this.networkId + '/devices';

    this.meraki = axios.create({
      baseURL: this.host,
      headers: {
        'X-Cisco-Meraki-API-Key': this.apiKey,
        'Content-Type': 'application/json; charset=utf-8',
        'Accept': 'application/json'
      }
    });

    //check if prefs directory ends with a /, if not then add it
    if (this.prefDir.endsWith('/') === false) {
      this.prefDir = this.prefDir + '/';
    }

    //check if the directory exists, if not then create it
    if (fs.existsSync(this.prefDir) === false) {
      fs.mkdir(this.prefDir, { recursive: false }, (error) => {
        if (error) {
          this.log.error('Device: %s , create directory: %s, error: %s', this.name, this.prefDir, error);
        } else {
          this.log.debug('Device: %s , create directory successful: %s', this.name, this.prefDir);
        }
      });
    }

    //Check device state
    setInterval(function () {
      if (this.checkDeviceState) {
        this.updateDeviceState();
      }
    }.bind(this), this.refreshInterval * 1000);

    this.prepareAccessory();
  }

  //Prepare accessory
  prepareAccessory() {
    this.log.debug('prepareAccessory');
    const accessoryName = this.name;
    const accessoryUUID = UUID.generate(accessoryName);
    const accessoryCategory = Categories.AIRPORT;
    this.accessory = new Accessory(accessoryName, accessoryUUID, accessoryCategory);

    this.prepareInformationService();
    this.prepareMerakiService();

    this.log.debug('Device: %s %s, publishExternalAccessories.', this.host, accessoryName);
    this.api.publishExternalAccessories(PLUGIN_NAME, [this.accessory]);
  }

  //Prepare information service
  prepareInformationService() {
    this.log.debug('prepareInformationService');
    this.getDeviceInfo();

    let manufacturer = this.manufacturer;
    let modelName = this.modelName;
    let serialNumber = this.serialNumber;
    let firmwareRevision = this.firmwareRevision;

    this.accessory.removeService(this.accessory.getService(Service.AccessoryInformation));
    this.informationService = new Service.AccessoryInformation();
    this.informationService
      .setCharacteristic(Characteristic.Name, this.name)
      .setCharacteristic(Characteristic.Manufacturer, manufacturer)
      .setCharacteristic(Characteristic.Model, modelName)
      .setCharacteristic(Characteristic.SerialNumber, serialNumber)
      .setCharacteristic(Characteristic.FirmwareRevision, firmwareRevision);

    this.accessory.addService(this.informationService);
  }

  //Prepare service 
  async prepareMerakiService() {
    this.log.debug('prepareMerakiService');
    try {
      if (this.type == "tempSensor") {
        this.merakiService1 = new Service.TemperatureSensor(this.name, 'merakiService1');
        this.merakiService1.getCharacteristic(Characteristic.CurrentTemperature)
                .setProps({
                      minValue: -100,
                      maxValue: 100
                  })
                .on('get', this.getTemperature.bind(this))
                .on('set', this.getTemperature.bind(this));
      }

      if (this.type == "humiditySensor") {
        this.merakiService1 = new Service.HumiditySensor(this.name, 'merakiService1');
        this.merakiService1.getCharacteristic(Characteristic.CurrentRelativeHumidity)
                .on('get', this.getHumidity.bind(this))
                .on('set', this.getHumidity.bind(this));
      }

      if (this.type == "doorSensor") {
        this.merakiService1 = new Service.ContactSensor(this.name, 'merakiService1');
        this.merakiService1.getCharacteristic(Characteristic.ContactSensorState)
                .on('get', this.getContactState.bind(this))
                .on('set', this.getContactState.bind(this));
      }

      if (this.type == "waterSensor") {
        this.merakiService1 = new Service.LeakSensor(this.name, 'merakiService1');
        this.merakiService1.getCharacteristic(Characteristic.LeakDetected)
                .on('get', this.getWaterState.bind(this))
                .on('set', this.getWaterState.bind(this));
      }

      if (this.type == "wlanControl") {
        const response = await this.meraki.get(this.mrUrl);
        let result = response.data;
        this.log.debug('Device %s, get device status data: %s', this.name, result);

        this.wlan0Name = result[0].name;
        this.merakiService1 = new Service.Switch(this.wlan0Name, 'merakiService1');

        this.merakiService1.getCharacteristic(Characteristic.On)
          .on('get', this.getWlan0State.bind(this))
          .on('set', this.setWlan0State.bind(this));
      }

      this.accessory.addService(this.merakiService1);
      this.checkDeviceState = true;

    } catch (error) {
      this.log.debug('Device: %s, state Offline, read SSIDs error: %s', this.name, error);
    };
  }

  async getDeviceInfo() {
    var me = this;
    try {
      me.log.info('Device: %s, state: Online.', me.name);
      me.log('-------- %s --------', me.name);
      me.log('Manufacturer: %s', me.manufacturer);
      me.log('Model: %s', me.modelName);
      me.log('Serialnr: %s', me.serialNumber);
      me.log('Firmware: %s', me.firmwareRevision);
      me.log('----------------------------------');
      me.updateDeviceState();
    } catch (error) {
      me.log.error('Device: %s, getDeviceInfo error: %s', me.name, error);
    }
  }

  async updateDeviceState() {
    var me = this;
    try {
      if (this.type == "tempSensor") {
        if (me.merakiService1) {
          const response = await me.meraki.get(me.mtStatsUrl + '?metric=temperature', { data: { serials: [me.serialNumber]} });
          me.log.info('got response %s', response.data[0]);
          let value = (response.data[0].value);
          me.log.info('Network: %s, Sensor: %s Value: %s', me.name, me.name, value);
          me.merakiService1.updateCharacteristic(Characteristic.CurrentTemperature, value);
        }
      }

      if (this.type == "humiditySensor") {
	if (me.merakiService1) {
          const humresponse = await me.meraki.get(me.mtStatsUrl + '?metric=humidity', { data: { serials: [me.serialNumber]} });
          me.log.info('got response %s', humresponse.data[0]);
          let humvalue = (humresponse.data[0].value);
          me.log.info('Network: %s, Sensor: %s Value: %s', me.name, me.name, humvalue);
          me.merakiService1.updateCharacteristic(Characteristic.CurrentRelativeHumidity, humvalue);
        }
      }

      if (this.type == "doorSensor") {
        if (me.merakiService1) {
          const response = await me.meraki.get(me.mtStatsUrl + '?metric=door', { data: { serials: [me.serialNumber]} });
          me.log.info('got response %s', response.data[0]);
          let value = (response.data[0].value);
          me.log.info('Network: %s, Sensor: %s Value: %s', me.name, me.name, value);
          me.merakiService1.updateCharacteristic(Characteristic.ContactSensorState, value);
        }
      }

      if (this.type == "waterSensor") {
        if (me.merakiService1) {
          const response = await me.meraki.get(me.mtStatsUrl + '?metric=water_detection', { data: { serials: [me.serialNumber]} });
          me.log.info('got response %s', response.data[0]);
          let value = (response.data[0].value);
          me.log.info('Network: %s, Sensor: %s Value: %s', me.name, me.name, value);
          me.merakiService1.updateCharacteristic(Characteristic.LeakDetected, value);
        }
      }

      if (me.serialNumber != "-" && me.modelName == "-") {
        // go get model numbers for devices we have serials for
	const response = await me.meraki.get(me.devicesUrl);
        var picked = response.data.find(o => o.serial === me.serialNumber);
        me.informationService.setCharacteristic(Characteristic.Model, picked['model'])
	me.modelName = picked['model'];
	me.log.info('%s: updated model to: %s', me.serialNumber, me.modelName);

      }

      if (this.type == "wlanControl") {
        const response = await me.meraki.get(me.mrUrl);
        me.log.debug('Device %s, get device status data: %s', me.name, response.data);
  
        let wlanLength = response.data.length;
        me.log.debug('Device: %s, number of available SSIDs: %s', me.name, wlanLength);
        me.wlanLength = wlanLength;
  
        if (me.wlanControl >= 1 && me.merakiService1) {
          let wlan0Name = response.data[0].name;
          let wlan0State = (response.data[0].enabled == true);
          me.merakiService1.updateCharacteristic(Characteristic.On, wlan0State);
          me.log.debug('UpdateDeviceState() - Device: %s, SSIDs: %s state: %s', me.name, wlan0Name, wlan0State ? 'ON' : 'OFF');
          me.wlan0Name = wlan0Name;
          me.wlan0State = wlan0State;
        }
      }
    } catch (error) {
      me.log.error('UpdateDeviceState() - Device: %s, update status error: %s, state: Offline', me.name, error);
    }
  }

  async getWlan0State(callback) {
    var me = this;
    try {
      const response = await me.meraki.get(me.mrUrl);
      let state = (response.data[0].enabled == true);
      me.log.info('getWlan0State() - Device: %s, SSIDs: %s state: %s', me.name, me.wlan0Name, state ? 'ON' : 'OFF');
      callback(null, state);
    } catch (error) {
      me.log.debug('Device: %s, SSIDs: %s get state error: %s', me.name, me.wlan0Name, error);
    };
  }

  async getTemperature(callback) {
    var me = this;
    try {
      const response = await me.meraki.get(me.mtStatsUrl + '?metric=temperature', { data: { serials: [me.serialNumber]} });
      let value = (response.data[0].value);
      me.log.info('getTemperature() - Network: %s, Sensor: %s Value: %s', me.name, me.name, value);
      callback(null, value);
    } catch (error) {
      me.log.debug('Device: %s, SSIDs: %s get state error: %s', me.name, me.serial, error);
    };
  }

  async getHumidity(callback) {
    var me = this;
    try {
      const response = await me.meraki.get(me.mtStatsUrl + '?metric=humidity', { data: { serials: [me.serialNumber]} });
      let value = (response.data[0].value);
      me.log.info('getHumidity() - Network: %s, Sensor: %s Value: %s', me.name, me.name, value);
      callback(null, value);
    } catch (error) {
      me.log.debug('Device: %s, SSIDs: %s get state error: %s', me.name, me.serial, error);
    };
  }

  async getContactState(callback) {
    var me = this;
    try {
      const response = await me.meraki.get(me.mtStatsUrl + '?metric=door', { data: { serials: [me.serialNumber]} });
      let value = (response.data[0].value);
      me.log.info('getContactState() - Network: %s, Sensor: %s Value: %s', me.name, me.name, value);
      callback(null, value);
    } catch (error) {
      me.log.debug('Device: %s, SSIDs: %s get state error: %s', me.name, me.serial, error);
    };
  }

  async getWaterState(callback) {
    var me = this;
    try {
      const response = await me.meraki.get(me.mtStatsUrl + '?metric=water_detection', { data: { serials: [me.serialNumber]} });
      let value = (response.data[0].value);
      me.log.info('getContactState() - Network: %s, Sensor: %s Value: %s', me.name, me.name, value);
      callback(null, value);
    } catch (error) {
      me.log.debug('Device: %s, SSIDs: %s get state error: %s', me.name, me.serial, error);
    };
  }

  async setWlan0State(state, callback) {
    var me = this;
    let newState = state ? true : false;
    let data = { 'enabled': newState };
    try {
      const response = await me.meraki.put(me.mrUrl + '/0', data);
      me.log.info('Device: %s, SSIDs: %s state: %s', me.name, me.wlan0Name, state ? 'ON' : 'OFF');
      callback(null, state);
    } catch (error) {
      me.log('Device: %s, SSIDs: %s set new state error: %s', me.name, me.wlan0Name, error);
    };
  }

}
