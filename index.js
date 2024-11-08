const dgram = require('dgram');
const socket = dgram.createSocket('udp4');

let Service, Characteristic;

module.exports = function(homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    homebridge.registerAccessory("homebridge-udp-fan", "UDPFan", UDPFanAccessory);
}

class UDPFanAccessory {
    constructor(log, config) {
        this.log = log;
        this.name = config.name;
        this.ip = config.ip;
        this.port = config.port;

        this.fanService = new Service.Fanv2(this.name);
        
        // Add rotation speed characteristic (for fan speed control)
        this.fanService.getCharacteristic(Characteristic.RotationSpeed)
            .setProps({
                minValue: 0,
                maxValue: 100,
                minStep: 33.33
            })
            .on('get', this.getSpeed.bind(this))
            .on('set', this.setSpeed.bind(this));

        // Add active characteristic (for on/off control)
        this.fanService.getCharacteristic(Characteristic.Active)
            .on('get', this.getActive.bind(this))
            .on('set', this.setActive.bind(this));
    }

    sendCommand(message) {
        return new Promise((resolve, reject) => {
            const buffer = Buffer.from(message);
            socket.send(buffer, 0, buffer.length, this.port, this.ip, (err) => {
                if (err) {
                    this.log.error('Error sending command:', err);
                    reject(err);
                }
            });

            // If we're requesting status, wait for response
            if (message === 's') {
                const timeout = setTimeout(() => {
                    socket.removeListener('message', handleMessage);
                    reject(new Error('Timeout waiting for response'));
                }, 1000);

                const handleMessage = (msg) => {
                    clearTimeout(timeout);
                    const response = msg.toString().split(',')[0];
                    resolve(parseInt(response));
                };

                socket.once('message', handleMessage);
            } else {
                resolve();
            }
        });
    }

    getSpeed(callback) {
        this.sendCommand('s')
            .then(speed => {
                // Convert fan speed (0-3) to percentage (0-100)
                const percentage = speed * 33.33;
                callback(null, percentage);
            })
            .catch(err => {
                this.log.error('Error getting speed:', err);
                callback(err);
            });
    }

    setSpeed(value, callback) {
        // Convert percentage (0-100) to fan speed (0-3)
        const speed = Math.round(value / 33.33);
        
        this.sendCommand(`s,${speed}`)
            .then(() => {
                callback(null);
            })
            .catch(err => {
                this.log.error('Error setting speed:', err);
                callback(err);
            });
    }

    getActive(callback) {
        this.sendCommand('s')
            .then(speed => {
                // If speed is 0, fan is off
                callback(null, speed > 0 ? 1 : 0);
            })
            .catch(err => {
                this.log.error('Error getting active state:', err);
                callback(err);
            });
    }

    setActive(value, callback) {
        this.sendCommand(`f,${value}`)
            .then(() => {
                callback(null);
            })
            .catch(err => {
                this.log.error('Error setting active state:', err);
                callback(err);
            });
    }

    getServices() {
        return [this.fanService];
    }
}