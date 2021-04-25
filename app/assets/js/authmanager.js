/**
 * AuthManager
 * 
 * This module aims to abstract login procedures. Results from Mojang's REST api
 * are retrieved through our Mojang module. These results are processed and stored,
 * if applicable, in the config using the ConfigManager. All login procedures should
 * be made through this module.
 * 
 * @module authmanager
 */
// Requirements
const ConfigManager = require('./configmanager')
const LoggerUtil = require('./loggerutil')
const Mojang = require('./mojang')
const logger = LoggerUtil('%c[AuthManager]', 'color: #a02d2a; font-weight: bold')
const loggerSuccess = LoggerUtil('%c[AuthManager]', 'color: #209b07; font-weight: bold')

// Functions

/**
 * Add an account. This will authenticate the given credentials with Mojang's
 * authserver. The resultant data will be stored as an auth account in the
 * configuration database.
 * 
 * @param {string} username The account username (email if migrated).
 * @param {string} password The account password.
 * @returns {Promise.<Object>} Promise which resolves the resolved authenticated account object.
 */
exports.addAccount = async function (username, password) {
    const session = await Mojang.authenticate(username, password, ConfigManager.getClientToken())
    if (!session.selectedProfile) {
        throw new Error('Error during authentication')
    }
    const ret = ConfigManager.addAuthAccount(session.selectedProfile.id, session.accessToken, session.selectedProfile.login, session.selectedProfile.name)
    if (ConfigManager.getClientToken() == null) {
        ConfigManager.setClientToken(session.clientToken)
    }
    ConfigManager.save()
    return ret
}

exports.registerAccount = async function (email) {
    return {userid: 123}
}

/**
 * Remove an account. This will invalidate the access token associated
 * with the account and then remove it from the database.
 * 
 * @param {string} uuid The UUID of the account to be removed.
 * @returns {Promise.<void>} Promise which resolves to void when the action is complete.
 */
exports.removeAccount = async function (uuid) {
    const account = ConfigManager.getAuthAccount(uuid)
    const clientToken = ConfigManager.getClientToken()
    ConfigManager.removeAuthAccount(uuid)
    ConfigManager.save()

    if (account && account.accessToken) {
        await Mojang.invalidate(account.accessToken, clientToken)
    }
}

/**
 * Validate the selected account with Mojang's authserver. If the account is not valid,
 * we will attempt to refresh the access token and update that value. If that fails, a
 * new login will be required.
 * 
 * **Function is WIP**
 * 
 * @returns {Promise.<boolean>} Promise which resolves to true if the access token is valid,
 * otherwise false.
 */
exports.validateSelected = async function () {
    const current = ConfigManager.getSelectedAccount()
    if (!current || !current.accessToken) {
        return false
    }
    const isValid = await Mojang.validate(current.accessToken, ConfigManager.getClientToken())
    if (isValid) {
        loggerSuccess.log('Account access token validated.')
        return true
    }

    try {
        const session = await Mojang.refresh(current.accessToken, ConfigManager.getClientToken())
        ConfigManager.updateAuthAccount(current.uuid, session.accessToken)
        ConfigManager.save()
    } catch (err) {
        logger.debug('Error while refreshig crrent profile token:', err)
        logger.log('Account access token is invalid.')
        return false
    }
    loggerSuccess.log('Account access token refreshed.')
    return true
}
