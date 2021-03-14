const fs = require('fs-extra')
const reg = require('native-reg')
const LoggerUtil = require('./loggerutil')
const logger = LoggerUtil('%c[DumpsManager]', 'color: #a02d2a; font-weight: bold')

const ConfigManager = require('./configmanager')

exports.createRules = async function (binaryName) {

    const dumpsDirectory = ConfigManager.getCrashDumpDirectory()
    await fs.promises.mkdir(dumpsDirectory, {recursive: true})

    const processWERkey = await new Promise((resolve, reject) => {
        let regKeyWER = reg.openKey(reg.HKCU, 'SOFTWARE\\Microsoft\\Windows\\Windows Error Reporting', reg.Access.ALL_ACCESS)
        if (regKeyWER === null) {
            logger.warn('WER registry key doesn\'t exist, creating...')
            regKeyWER = reg.createKey(reg.HKCU, 'SOFTWARE\\Microsoft\\Windows\\Windows Error Reporting', reg.Access.ALL_ACCESS)
            reg.setValueDWORD(regKeyWER, 'Disabled', '1')
        } else if (reg.getValue(regKeyWER, '', 'Disabled') !== 1) {
            logger.warn('WER is disabled, enabling...')
            reg.setValueDWORD(regKeyWER, 'Disabled', '1')
        }
        reg.closeKey(regKeyWER)
        resolve()
    })

    const processDumpsKey = await new Promise((resolve, reject) => {
        let regKeyDumps = reg.openKey(reg.HKCU, `SOFTWARE\\Microsoft\\Windows\\Windows Error Reporting\\LocalDumps\\${binaryName}`, reg.Access.ALL_ACCESS)
        if (regKeyDumps === null) {
            logger.warn('Dumps registry key doesn\'t exist, creating...')
            regKeyDumps = reg.createKey(reg.HKCU, `SOFTWARE\\Microsoft\\Windows\\Windows Error Reporting\\LocalDumps\\${binaryName}`, reg.Access.ALL_ACCESS)
            reg.setValueDWORD(regKeyDumps, 'DumpCount', '3')
            reg.setValueDWORD(regKeyDumps, 'DumpType', '1')
            reg.setValueEXPAND_SZ(regKeyDumps, 'DumpFolder', dumpsDirectory)
        }
        reg.closeKey(regKeyDumps)
        resolve()
    })

    await Promise.all([
        processWERkey,
        processDumpsKey
    ])
}