const fs = require('fs-extra')
const util = require('util')
const Registry = require('winreg')

const ConfigManager = require('./configmanager')

exports.createRules = async function (binaryName) {
    let regKeyWER = new Registry({
        hive: Registry.HKCU,
        key: '\\SOFTWARE\\Microsoft\\Windows\\Windows Error Reporting',

    })

    let regKeyDumps = new Registry({
        hive: Registry.HKCU,
        key: `\\SOFTWARE\\Microsoft\\Windows\\Windows Error Reporting\\LocalDumps\\${binaryName}`,

    })

    const aWERKeyExists = util.promisify(regKeyWER.keyExists).bind(regKeyWER)
    const aDumpsKeyExists = util.promisify(regKeyDumps.keyExists).bind(regKeyDumps)
    const aCreateWERKey = util.promisify(regKeyWER.create).bind(regKeyWER)
    const aCreateDumpsKey = util.promisify(regKeyDumps.create).bind(regKeyDumps)
    const asetWER = util.promisify(regKeyWER.set).bind(regKeyWER)
    const asetDumps = util.promisify(regKeyDumps.set).bind(regKeyDumps)

    let keyExists = await aWERKeyExists()
    if (!keyExists) {
        await aCreateWERKey()
    }
    keyExists = await aDumpsKeyExists()
    if (!keyExists) {
        await aCreateDumpsKey()
    }

    const dumpsDirectory = ConfigManager.getCrashDumpDirectory()
    await fs.promises.mkdir(dumpsDirectory, {recursive: true})
    await Promise.all([
        asetWER('Disabled', Registry.REG_DWORD, '1'),
        asetDumps('DumpFolder', Registry.REG_EXPAND_SZ, dumpsDirectory),
        asetDumps('DumpCount', Registry.REG_DWORD, '3'),
        asetDumps('DumpType', Registry.REG_DWORD, '1'),
    ])
}