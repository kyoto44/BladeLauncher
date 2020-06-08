/**
 * Script for auth.ejs
 */

// auth Elements
const authCancelContainer  = document.getElementById('authCancelContainer')
const authCancelButton     = document.getElementById('authCancelButton')
const authEmailError       = document.getElementById('authEmailError')
const authUsername         = document.getElementById('authUsername')
const authPasswordError    = document.getElementById('authPasswordError')
const authPassword         = document.getElementById('authPassword')
const authRememberOption   = document.getElementById('authRememberOption')
const authButton           = document.getElementById('authButton')
const authForm             = document.getElementById('authForm')
const showPassword         = document.getElementById('passwordVisibleImg')

// Control variables.
// let lu = false, lp = false


// /**
//  * Show a auth error.
//  * 
//  * @param {HTMLElement} element The element on which to display the error.
//  * @param {string} value The error text.
//  */
// function showError(element, value){
//     element.innerHTML = value
//     element.style.opacity = 1
// }

/**
 * Shake a auth error to add emphasis.
 * 
 * @param {HTMLElement} element The element to shake.
 */
function shakeError(element){
    if(element.style.opacity == 1){
        element.classList.remove('shake')
        void element.offsetWidth
        element.classList.add('shake')
    }
}

/**
 * Validate that an email field is neither empty nor invalid.
 * 
 * @param {string} value The email value.
 */
function validateAuthEmail(value){
    if(value){
        if(!validUsername.test(value)){
            showError(authEmailError, Lang.queryJS('auth.error.invalidEmail'))
            authDisabled(true)
            lu = false
        } else {
            authEmailError.style.opacity = 0
            lu = true
            if(lp){
                authDisabled(false)
            }
        }
    } else {
        lu = false
        showError(authEmailError, Lang.queryJS('auth.error.requiredValue'))
        authDisabled(true)
    }
}

/**
 * Validate that the password field is not empty.
 * 
 * @param {string} value The password value.
 */
function validatePassword(value){
    if(value){
        authPasswordError.style.opacity = 0
        lp = true
        if(lu){
            authDisabled(false)
        }
    } else {
        lp = false
        showError(authPasswordError, Lang.queryJS('auth.error.invalidValue'))
        authDisabled(true)
    }
}

// Emphasize errors with shake when focus is lost.
authUsername.addEventListener('focusout', (e) => {
    validateAuthEmail(e.target.value)
    shakeError(authEmailError)
})
authPassword.addEventListener('focusout', (e) => {
    validatePassword(e.target.value)
    shakeError(authPasswordError)
})

// Validate input for each field.
authUsername.addEventListener('input', (e) => {
    validateAuthEmail(e.target.value)
})
authPassword.addEventListener('input', (e) => {
    validatePassword(e.target.value)
})

// Open register page

register.addEventListener('click', (e) => {
    $('#registerContainer').show()
    $('#authContainer').hide()
})

// Show & hide password

showPassword.addEventListener('click', (e) => {
    if (authPassword.type == 'password') {
        authPassword.type = 'text'
        showPassword.classList.add('passwordVisible')
    }
    else if (authPassword.type == 'text'){
        authPassword.type = 'password'
        showPassword.classList.remove('passwordVisible')
    }
})


/**
 * Enable or disable the auth button.
 * 
 * @param {boolean} v True to enable, false to disable.
 */
function authDisabled(v){
    if(authButton.disabled !== v){
        authButton.disabled = v
    }
}

/**
 * Enable or disable loading elements.
 * 
 * @param {boolean} v True to enable, false to disable.
 */
function authLoading(v){
    if(v){
        authButton.setAttribute('loading', v)
        authButton.innerHTML = authButton.innerHTML.replace(Lang.queryJS('auth.auth'), Lang.queryJS('auth.loggingIn'))
    } else {
        authButton.removeAttribute('loading')
        authButton.innerHTML = authButton.innerHTML.replace(Lang.queryJS('auth.loggingIn'), Lang.queryJS('auth.auth'))
    }
}

/**
 * Enable or disable auth form.
 * 
 * @param {boolean} v True to enable, false to disable.
 */
function formAuthDisabled(v){
    authDisabled(v)
    authCancelButton.disabled = v
    authUsername.disabled = v
    authPassword.disabled = v
    if(v){
        checkmarkContainer.setAttribute('disabled', v)
    } else {
        checkmarkContainer.removeAttribute('disabled')
    }
    authRememberOption.disabled = v
}

/**
 * Parses an error and returns a user-friendly title and description
 * for our error overlay.
 * 
 * @param {Error | {cause: string, error: string, errorMessage: string}} err A Node.js
 * error or Mojang error response.
 */
function resolveError(err){
    // Mojang Response => err.cause | err.error | err.errorMessage
    // Node error => err.code | err.message
    if(err.cause != null && err.cause === 'UserMigratedException') {
        return {
            title: Lang.queryJS('auth.error.userMigrated.title'),
            desc: Lang.queryJS('auth.error.userMigrated.desc')
        }
    } else {
        if(err.error != null){
            switch (err.error) {
                case 'ForbiddenOperationException': {
                    if (err.errorMessage != null) {
                        if (err.errorMessage === 'Invalid credentials. Invalid username or password.') {
                            return {
                                title: Lang.queryJS('auth.error.invalidCredentials.title'),
                                desc: Lang.queryJS('auth.error.invalidCredentials.desc')
                            }
                        } else if(err.errorMessage === 'Invalid credentials.') {
                            return {
                                title: Lang.queryJS('auth.error.rateLimit.title'),
                                desc: Lang.queryJS('auth.error.rateLimit.desc')
                            }
                        }
                    }
                }
                case 'Registration was not completed': {
                    if (err.errorMessage != null && err.errorMessage.startsWith('Please confirm you email address first.')) {
                        return {
                            title: Lang.queryJS('auth.error.emailNotConfirmed.title'),
                            desc: Lang.queryJS('auth.error.emailNotConfirmed.desc')
                        }
                    }
                }
            }
        } else {
            // Request errors (from Node).
            if(err.code != null){
                if(err.code === 'ENOENT'){
                    // No Internet.
                    return {
                        title: Lang.queryJS('auth.error.noInternet.title'),
                        desc: Lang.queryJS('auth.error.noInternet.desc')
                    }
                } else if(err.code === 'ENOTFOUND'){
                    // Could not reach server.
                    return {
                        title: Lang.queryJS('auth.error.authDown.title'),
                        desc: Lang.queryJS('auth.error.authDown.desc')
                    }
                }
            }
        }
    }
    if(err.message != null){
        if(err.message === 'NotPaidAccount'){
            return {
                title: Lang.queryJS('auth.error.notPaid.title'),
                desc: Lang.queryJS('auth.error.notPaid.desc')
            }
        }
    }
    return {
        title: Lang.queryJS('auth.error.unknown.title'),
        desc: Lang.queryJS('auth.error.unknown.desk')
    }
}

let authViewOnSuccess = VIEWS.landing
let authViewOnCancel = VIEWS.settings
let authViewCancelHandler

function authCancelEnabled(val){
    if(val){
        $(authCancelContainer).show()
    } else {
        $(authCancelContainer).hide()
    }
}

// authCancelButton.onclick = (e) => {
//     switchView(getCurrentView(), authViewOnCancel, 500, 500, () => {
//         authUsername.value = ''
//         authPassword.value = ''
//         authCancelEnabled(false)
//         if(authViewCancelHandler != null){
//             authViewCancelHandler()
//             authViewCancelHandler = null
//         }
//     })
// }

// Disable default form behavior.
authForm.onsubmit = () => { return false }

// Bind auth button behavior.
authButton.addEventListener('click', () => {
    // Disable form.
    // formAuthDisabled(true)

    // Show loading stuff.
    authLoading(true)

    AuthManager.addAccount(authUsername.value, authPassword.value)
        .then((value) => {
            return DistroManager.refresh()
                .then((d) => onDistroRefresh(d))
                .then(() => value)
        })    
        .then((value) => {
            updateSelectedAccount(value)
            authButton.innerHTML = authButton.innerHTML.replace(Lang.queryJS('auth.loggingIn'), Lang.queryJS('auth.success'))
            $('.circle-loader').toggleClass('load-complete')
            $('.checkmark').toggle()
            setTimeout(() => {
                switchView(VIEWS.auth, authViewOnSuccess, 500, 500, () => {
                    // Temporary workaround
                    if(authViewOnSuccess === VIEWS.settings){
                        prepareSettings()
                    }
                    authViewOnSuccess = VIEWS.landing // Reset this for good measure.
                    authCancelEnabled(false) // Reset this for good measure.
                    authViewCancelHandler = null // Reset this for good measure.
                    authUsername.value = ''
                    authPassword.value = ''
                    $('.circle-loader').toggleClass('load-complete')
                    $('.checkmark').toggle()
                    authLoading(false)
                    authButton.innerHTML = authButton.innerHTML.replace(Lang.queryJS('auth.success'), Lang.queryJS('auth.auth'))
                    formAuthDisabled(false)
                })
            }, 1000)
        }).catch((err) => {
            authLoading(false)
            const errF = resolveError(err)
            setOverlayContent(errF.title, errF.desc, Lang.queryJS('auth.tryAgain'))
            setOverlayHandler(() => {
                // formAuthDisabled(false)
                toggleOverlay(false)
            })
            toggleOverlay(true)
            loggerauth.warn('Error while logging in.', err)
        })

})

authUsername.setAttribute('placeholder', Lang.queryJS('auth.authUsername'))
authPassword.setAttribute('placeholder', Lang.queryJS('auth.authPassword'))