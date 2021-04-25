/**
 * Mojang
 * 
 * This module serves as a minimal wrapper for Mojang's REST api.
 * 
 * @module mojang
 */
// Requirements
const got = require('got')
const crypto = require('crypto')
const {remote} = require('electron')
const logger = require('./loggerutil')('%c[Mojang]', 'color: #a02d2a; font-weight: bold')

// Constants
const minecraftAgent = {
    name: 'BladeLauncher',
    version: remote.app.getVersion()
    // Todo: add fingerprint
}
const authpath = 'https://www.northernblade.ru/api'
const statuses = [
    {
        service: 'sessionserver.mojang.com',
        status: 'grey',
        name: 'Multiplayer Session Service',
        essential: true
    },
    {
        service: 'authserver.mojang.com',
        status: 'grey',
        name: 'Authentication Service',
        essential: true
    },
    {
        service: 'textures.minecraft.net',
        status: 'grey',
        name: 'Minecraft Skins',
        essential: false
    },
    {
        service: 'api.mojang.com',
        status: 'grey',
        name: 'Public API',
        essential: false
    },
    {
        service: 'minecraft.net',
        status: 'grey',
        name: 'Minecraft.net',
        essential: false
    },
    {
        service: 'account.mojang.com',
        status: 'grey',
        name: 'Mojang Accounts Website',
        essential: false
    }
]

// Functions

/**
 * Converts a Mojang status color to a hex value. Valid statuses
 * are 'green', 'yellow', 'red', and 'grey'. Grey is a custom status
 * to our project which represents an unknown status.
 * 
 * @param {string} status A valid status code.
 * @returns {string} The hex color of the status code.
 */
exports.statusToHex = function (status) {
    switch (status.toLowerCase()) {
        case 'green':
            return '#a5c325'
        case 'yellow':
            return '#eac918'
        case 'red':
            return '#c32625'
        case 'grey':
        default:
            return '#848484'
    }
}

/**
 * Retrieves the status of Mojang's services.
 * The response is condensed into a single object. Each service is
 * a key, where the value is an object containing a status and name
 * property.
 * 
 * @see http://wiki.vg/Mojang_API#API_Status
 */
exports.status = function () {
    /*
    return new Promise((resolve, reject) => {
        got.get('https://status.mojang.com/check',
            {
                json: true,
                timeout: 2500
            },
            function (error, response, body) {

                if (error || response.statusCode !== 200) {
                    logger.warn('Unable to retrieve Mojang status.')
                    logger.debug('Error while retrieving Mojang statuses:', error)
                    //reject(error || response.statusCode)
                    for (let i = 0; i < statuses.length; i++) {
                        statuses[i].status = 'grey'
                    }
                    resolve(statuses)
                } else {
                    for (let i = 0; i < body.length; i++) {
                        const key = Object.keys(body[i])[0]
                        inner:
                        for (let j = 0; j < statuses.length; j++) {
                            if (statuses[j].service === key) {
                                statuses[j].status = body[i][key]
                                break inner
                            }
                        }
                    }
                    resolve(statuses)
                }
            })
    })
    */
}

/**
 * Authenticate a user with their Mojang credentials.
 * 
 * @param {string} username The user's username, this is often an email.
 * @param {string} password The user's password.
 * @param {string} clientToken The launcher's Client Token.
 * @param {boolean} requestUser Optional. Adds user object to the reponse.
 * @param {Object} agent Optional. Provided by default. Adds user info to the response.
 * 
 * @see http://wiki.vg/Authentication#Authenticate
 */
exports.authenticate = async (username, password, clientToken, requestUser = true, agent = minecraftAgent) => {
    const authJSON = {
        'agent': agent,
        'username': username,
        'requestUser': requestUser,
        'password': crypto.createHash('md5').update(password).digest('hex'),
    }

    if (clientToken != null) {
        authJSON['clientToken'] = clientToken
    }

    try {
        const request = await got.post(authpath + '/authenticate', {
            json: authJSON
        })

        const response = JSON.parse(request.body)

        if (request.statusCode === 200) {
            return response
        }

        let errorTitle = 'Error during authentication'
        let errorMessage = 'Please contact support'
        if (typeof response === 'object' && typeof response.error === 'object') {
            switch (response.error.code) {
                case 'email_not_confirmed':
                    errorTitle = 'Registration was not completed'
                    errorMessage = 'Please confirm you email address first.'
                    if (response.error.url) {
                        errorMessage += `<br/>Visit <a href="${response.error.url}">link</a> for more information`
                    }
                    break
                case 'too_many_bad_login_attempts':
                    errorTitle = 'ForbiddenOperationException'
                    errorMessage = 'Invalid credentials.'
                    break
                case 'invalid_credential':
                    errorTitle = 'ForbiddenOperationException'
                    errorMessage = 'Invalid credentials. Invalid username or password.'
                    break

            }
        } else {
            logger.error('Error during authentication with status code (' + request.statusCode + '): ', response)
        }

        throw ({
            error: errorTitle,
            errorMessage
        })

    } catch (error) {
        throw new Error('Error during authentication.', error)
    }


}

/**
 * Validate an access token. This should always be done before launching.
 * The client token should match the one used to create the access token.
 * 
 * @param {string} accessToken The access token to validate.
 * @param {string} clientToken The launcher's client token.
 * 
 * @see http://wiki.vg/Authentication#Validate
 */
exports.validate = async (accessToken, clientToken) => {
    try {
        const response = await got.post(authpath + '/validate', {
            json: {
                'accessToken': accessToken,
                'clientToken': clientToken
            }
        })

        if (response.statusCode === 204) {
            return true
        } else {
            return false
        }
    } catch (error) {
        throw new Error('Error during validation.', error)
    }
}

/**
 * Invalidates an access token. The clientToken must match the
 * token used to create the provided accessToken.
 * 
 * @param {string} accessToken The access token to invalidate.
 * @param {string} clientToken The launcher's client token.
 * 
 * @see http://wiki.vg/Authentication#Invalidate
 */
exports.invalidate = async (accessToken, clientToken) => {
    try {
        const response = await got.post(authpath + '/invalidate', {
            json: {
                'accessToken': accessToken,
                'clientToken': clientToken
            }
        })

        if (response.statusCode === 204) {
            return
        } else {
            throw new Error(JSON.parse(response.body))
        }
    } catch (error) {
        throw new Error('Error during invalidation.', error)
    }
}

/**
 * Refresh a user's authentication. This should be used to keep a user logged
 * in without asking them for their credentials again. A new access token will
 * be generated using a recent invalid access token. See Wiki for more info.
 * 
 * @param {string} accessToken The old access token.
 * @param {string} clientToken The launcher's client token.
 * @param {boolean} requestUser Optional. Adds user object to the reponse.
 * 
 * @see http://wiki.vg/Authentication#Refresh
 */
exports.refresh = async (accessToken, clientToken, requestUser = true) => {
    try {
        const response = await got.post(authpath + '/refresh', {
            json: {
                'accessToken': accessToken,
                'clientToken': clientToken,
                'requestUser': requestUser
            }
        })

        if (response.statusCode === 200) {
            return JSON.parse(response.body)
        } else {
            throw new Error(JSON.parse(response.body))
        }
    } catch (error) {
        throw new Error('Error during refresh.', error)
    }
}