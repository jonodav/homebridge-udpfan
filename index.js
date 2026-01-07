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
        
        // Configuration for retries
        this.maxRetries = config.maxRetries || 3;
        this.retryDelay = config.retryDelay || 200; // ms between retries
        this.timeout = config.timeout || 1000; // ms to wait for response
        
        // State caching to reduce unnecessary queries
        this.cachedSpeed = null;
        this.cachedActive = null;
        this.cacheTimeout = config.cacheTimeout || 2000; // ms to cache state
        this.lastUpdate = 0;
        
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

    /**
     * Send command with automatic retry logic
     */
    async sendCommand(message, expectResponse = false, retryCount = 0) {
        return new Promise((resolve, reject) => {
            const buffer = Buffer.from(message);
            
            socket.send(buffer, 0, buffer.length, this.port, this.ip, (err) => {
                if (err) {
                    this.log.error(`Error sending command (attempt ${retryCount + 1}):`, err);
                    
                    // Retry if we haven't exceeded max retries
                    if (retryCount < this.maxRetries) {
                        setTimeout(() => {
                            this.sendCommand(message, expectResponse, retryCount + 1)
                                .then(resolve)
                                .catch(reject);
                        }, this.retryDelay);
                    } else {
                        reject(err);
                    }
                    return;
                }
            });

            // If we're requesting status, wait for response
            if (expectResponse) {
                const timeout = setTimeout(() => {
                    socket.removeListener('message', handleMessage);
                    
                    // Retry on timeout
                    if (retryCount < this.maxRetries) {
                        this.log.warn(`Timeout waiting for response (attempt ${retryCount + 1}), retrying...`);
                        setTimeout(() => {
                            this.sendCommand(message, expectResponse, retryCount + 1)
                                .then(resolve)
                                .catch(reject);
                        }, this.retryDelay);
                    } else {
                        this.log.error(`Failed after ${this.maxRetries} retries`);
                        reject(new Error('Timeout waiting for response after retries'));
                    }
                }, this.timeout);

                const handleMessage = (msg) => {
                    clearTimeout(timeout);
                    socket.removeListener('message', handleMessage);
                    
                    try {
                        const response = msg.toString().split(',')[0];
                        const value = parseInt(response);
                        
                        if (isNaN(value)) {
                            throw new Error('Invalid response from device');
                        }
                        
                        resolve(value);
                    } catch (err) {
                        this.log.error('Error parsing response:', err);
                        reject(err);
                    }
                };

                socket.on('message', handleMessage);
            } else {
                // For commands that don't expect a response, resolve immediately
                resolve();
            }
        });
    }

    /**
     * Send command with confirmation by checking state afterward
     */
    async sendCommandWithConfirmation(message, expectedValue = null) {
        try {
            // Send the command with retries
            await this.sendCommand(message, false);
            
            // If we expect a specific value, verify it was set
            if (expectedValue !== null) {
                // Small delay to allow device to process
                await new Promise(resolve => setTimeout(resolve, 100));
                
                // Query status to confirm
                const actualValue = await this.sendCommand('s', true);
                
                if (actualValue !== expectedValue) {
                    this.log.warn(`Command may have failed. Expected: ${expectedValue}, Got: ${actualValue}`);
                    // Try one more time
                    await this.sendCommand(message, false);
                }
                
                return actualValue;
            }
            
            return null;
        } catch (err) {
            this.log.error('Error in sendCommandWithConfirmation:', err);
            throw err;
        }
    }

    /**
     * Update cached state
     */
    updateCache(speed) {
        this.cachedSpeed = speed;
        this.cachedActive = speed > 0 ? 1 : 0;
        this.lastUpdate = Date.now();
    }

    /**
     * Check if cache is still valid
     */
    isCacheValid() {
        return (Date.now() - this.lastUpdate) < this.cacheTimeout;
    }

    async getSpeed(callback) {
        try {
            // Use cache if valid
            if (this.isCacheValid() && this.cachedSpeed !== null) {
                const percentage = this.cachedSpeed * 33.33;
                callback(null, percentage);
                return;
            }

            const speed = await this.sendCommand('s', true);
            this.updateCache(speed);
            
            // Convert fan speed (0-3) to percentage (0-100)
            const percentage = speed * 33.33;
            callback(null, percentage);
        } catch (err) {
            this.log.error('Error getting speed:', err);
            
            // Return cached value if available
            if (this.cachedSpeed !== null) {
                this.log.warn('Returning cached speed value');
                callback(null, this.cachedSpeed * 33.33);
            } else {
                callback(err);
            }
        }
    }

    async setSpeed(value, callback) {
        try {
            // Convert percentage (0-100) to fan speed (0-3)
            const speed = Math.round(value / 33.33);
            
            await this.sendCommandWithConfirmation(`s,${speed}`, speed);
            this.updateCache(speed);
            
            callback(null);
        } catch (err) {
            this.log.error('Error setting speed:', err);
            callback(err);
        }
    }

    async getActive(callback) {
        try {
            // Use cache if valid
            if (this.isCacheValid() && this.cachedActive !== null) {
                callback(null, this.cachedActive);
                return;
            }

            const speed = await this.sendCommand('s', true);
            this.updateCache(speed);
            
            // If speed is 0, fan is off
            callback(null, speed > 0 ? 1 : 0);
        } catch (err) {
            this.log.error('Error getting active state:', err);
            
            // Return cached value if available
            if (this.cachedActive !== null) {
                this.log.warn('Returning cached active state');
                callback(null, this.cachedActive);
            } else {
                callback(err);
            }
        }
    }

    async setActive(value, callback) {
        try {
            await this.sendCommand(`f,${value}`, false);
            
            // Update cache based on the command sent
            if (value === 0) {
                this.updateCache(0);
            } else {
                // Verify the actual state since turning on might set a specific speed
                const speed = await this.sendCommand('s', true);
                this.updateCache(speed);
            }
            
            callback(null);
        } catch (err) {
            this.log.error('Error setting active state:', err);
            callback(err);
        }
    }

    getServices() {
        return [this.fanService];
    }
}
