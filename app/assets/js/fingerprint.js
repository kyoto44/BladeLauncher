
const { EOL, endianness } = require('os')
const { createHash } = require('crypto')
let {
    system,
    bios,
    baseboard,
    cpu,
    mem,
    osInfo,
    blockDevices
} = require('systeminformation')

const FINGERPRINTING_INFO = (async function() {
    const hwinfo = await Promise.all([
        system(),
        bios(),
        baseboard(),
        cpu(),
        mem(),
        osInfo(),
        blockDevices()
    ]).then(([system, bios, baseboard, cpu, mem, osInfo, blockDevices]) => {
        const { manufacturer, model, serial, uuid } = system,
            { vendor, version: biosVersion, releaseDate } = bios, 
            {
                manufacturer: boardManufacturer,
                model: boardModel,
                serial: boardSerial
            } = baseboard,
            {
                manufacturer: cpuManufacturer,
                brand,
                speedmax,
                cores,
                physicalCores,
                socket
            } = cpu,
            { total: memTotal } = mem,
            { platform, arch } = osInfo,
            devices = blockDevices
    
        const hdds = devices
            .filter(({ type, removable }) => type === 'disk' && !removable)
            .map(({ model, serial }) => model + serial)
          
        return {
            EOL,
            endianess: endianness(),
            manufacturer,
            model,
            serial,
            uuid,
            vendor,
            biosVersion,
            releaseDate,
            boardManufacturer,
            boardModel,
            boardSerial,
            cpuManufacturer,
            brand,
            speedmax,
            cores,
            physicalCores,
            socket,
            memTotal,
            platform,
            arch,
            hdds
        }   
    })    

    return hwinfo
})()

const FINGERPRINT = (async function() {
    const fingerprintingInfo = await FINGERPRINTING_INFO
    const fingerprintString = Object.values(fingerprintingInfo).join('')
    const fingerprintHash = createHash('sha512').update(fingerprintString)
    return fingerprintHash.digest('hex')
})()

function getFingerprint() {
    return FINGERPRINT
}

function getFingerprintingInfo() {
    return FINGERPRINTING_INFO
}

module.exports = { getFingerprint, getFingerprintingInfo }