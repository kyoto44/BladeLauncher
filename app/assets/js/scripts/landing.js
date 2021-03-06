/**
 * Script for landing.ejs
 */
// Requirements
const cp = require('child_process')
const crypto = require('crypto')
const {URL} = require('url')

// Internal Requirements
const DiscordWrapper = require('./assets/js/discordwrapper')
const ProcessBuilder = require('./assets/js/basicprocessbuilder')
const {LogsReporter} = require('./assets/js/reportmanager')

// Launch Elements
const launch_content = document.getElementById('launch_content')
const launch_details = document.getElementById('launch_details')
const launch_progress = document.getElementById('launch_progress')
const launch_progress_label = document.getElementById('launch_progress_label')
const launch_details_text = document.getElementById('launch_details_text')
const server_selection_button = document.getElementById('server_selection_button')
const user_text = document.getElementById('user_text')

const log = require('electron-log')
const loggerLanding = LoggerUtil('%c[Landing]', 'color: #000668; font-weight: bold')

/* Launch Progress Wrapper Functions */

/**
 * Show/hide the loading area.
 *
 * @param {boolean} loading True if the loading area should be shown, otherwise false.
 */
function toggleLaunchArea(loading) {
    if (loading) {
        launch_details.style.display = 'flex'
        launch_content.style.display = 'none'
    } else {
        launch_details.style.display = 'none'
        launch_content.style.display = 'inline-flex'
    }
}

/**
 * Set the details text of the loading area.
 *
 * @param {string} details The new text for the loading details.
 */
function setLaunchDetails(details) {
    launch_details_text.innerHTML = details
}

/**
 * Set the value of the loading progress bar and display that value.
 *
 * @param {number} value The progress value.
 * @param {number} max The total size.
 * @param {number|string} percent Optional. The percentage to display on the progress label.
 */
function setLaunchPercentage(value, max, percent = ((value / max) * 100)) {
    launch_progress.setAttribute('max', max)
    launch_progress.setAttribute('value', value)
    launch_progress_label.innerHTML = percent + '%'
}

/**
 * Set the value of the OS progress bar and display that on the UI.
 *
 * @param {number} value The progress value.
 * @param {number} max The total download size.
 * @param {number|string} percent Optional. The percentage to display on the progress label.
 */
function setDownloadPercentage(value, max, percent = ((value / max) * 100)) {
    remote.getCurrentWindow().setProgressBar(value / max)
    setLaunchPercentage(value, max, percent)
}

/**
 * Enable or disable the launch button.
 *
 * @param {boolean} val True to enable, false to disable.
 */
function setLaunchEnabled(val) {
    document.getElementById('launch_button').disabled = !val
}

// Bind launch button
document.getElementById('launch_button').addEventListener('click', function (e) {
    loggerLanding.log('Launching game..')

    dlAsync()
})

// Bind settings button
document.getElementById('settingsMediaButton').onclick = (e) => {
    prepareSettings()
    switchView(getCurrentView(), VIEWS.settings)
}

// Bind avatar overlay button.
document.getElementById('avatarOverlay').onclick = (e) => {
    prepareSettings()
    switchView(getCurrentView(), VIEWS.settings, 500, 500, () => {
        settingsNavItemListener(document.getElementById('settingsNavAccount'), false)
    })
}

// Bind selected account
function updateSelectedAccount(authUser) {
    let username = 'No Account Selected'
    if (authUser != null) {
        if (authUser.displayName != null) {
            username = authUser.displayName
        }
        if (authUser.uuid != null) {
            document.getElementById('avatarContainer').style.backgroundImage = `url('https://www.northernblade.ru/forums/image.php?u=${authUser.uuid}')`
        }
    }
    user_text.innerHTML = username
}

updateSelectedAccount(ConfigManager.getSelectedAccount())

// Bind selected server
function updateSelectedServer(serv) {
    ConfigManager.setSelectedServer(serv != null ? serv.getID() : null)
    ConfigManager.save()
    server_selection_button.innerHTML = '\u2022 ' + (serv != null ? serv.getName() : 'No Server Selected')

    setLaunchEnabled(serv != null)
    return Promise.resolve()
}

// Real text is set in uibinder.js on distributionIndexDone.
server_selection_button.innerHTML = '\u2022 Loading..'
server_selection_button.onclick = (e) => {
    e.target.blur()

    const distro = DistroManager.getDistribution()
    if (distro == null) {
        return
    }
    const channels = ConfigManager.getReleaseChannels()
    const servers = distro.getServers(channels)
    if (servers.length < 2) {
        return
    }

    toggleServerSelection(true)
}

// Update Mojang Status Color
const refreshMojangStatuses = async function () {
}

const refreshServerStatus = async function (fade = false) {
}

refreshMojangStatuses()
// Server Status is refreshed in uibinder.js on distributionIndexDone.

// Set refresh rate to once every 5 minutes.
// let mojangStatusListener = setInterval(() => refreshMojangStatuses(true), 300000)
// let serverStatusListener = setInterval(() => refreshServerStatus(true), 300000)

/**
 * Shows an error overlay, toggles off the launch area.
 *
 * @param {string} title The overlay title.
 * @param {string} desc The overlay description.
 */
function showLaunchFailure(title, desc, accept = 'Okay', handler = null) {
    setOverlayContent(
        title,
        desc,
        accept
    )
    setOverlayHandler(handler)
    toggleOverlay(true)
    toggleLaunchArea(false)
}

// Keep reference to Game Process
let pb
// Is DiscordRPC enabled
let hasRPC = false
// Joined server regex
const SERVER_JOINED_REGEX = /\[.+\]: \[CHAT\] [a-zA-Z0-9_]{1,16} joined the game/
const GAME_JOINED_REGEX = /\[.+\]: Skipping bad option: lastServer:/
const GAME_LAUNCH_REGEX = /^\[.+\]: MinecraftForge .+ Initialized$/

let aEx
let serv
let versionData
let forgeData

let progressListener

function dlAsync(login = true) {

    // Login parameter is temporary for debug purposes. Allows testing the validation/downloads without
    // launching the game.

    if (login) {
        if (ConfigManager.getSelectedAccount() == null) {
            loggerLanding.error('You must be logged into an account.')
            return
        }
    }

    setLaunchDetails(Lang.queryJS('landing.launch.pleaseWait'))
    toggleLaunchArea(true)
    setLaunchPercentage(0, 100)

    const loggerLaunchSuite = LoggerUtil('%c[LaunchSuite]', 'color: #000668; font-weight: bold')

    const forkEnv = JSON.parse(JSON.stringify(process.env))
    forkEnv.CONFIG_DIRECT_PATH = ConfigManager.getLauncherDirectory()
    log.transports.file.level = true
    // Start AssetExec to run validations and downloads in a forked process.
    aEx = cp.fork(path.join(__dirname, 'assets', 'js', 'assetexec.js'), [
        'AssetGuard',
        remote.app.getVersion()
    ], {
        env: forkEnv,
        //execArgv:['--inspect-brk'],
        stdio: 'pipe'
    })
    // Stdout
    aEx.stdio[1].setEncoding('utf8')
    aEx.stdio[1].on('data', (data) => {
        log.info(data)
    })
    // Stderr
    aEx.stdio[2].setEncoding('utf8')
    aEx.stdio[2].on('data', (data) => {
        log.info(data)
    })

    const listener = (event, ...args) => {
        aEx.send({
            task: 'execute',
            function: 'torrentsNotification',
            argsArr: args
        })
    }
    ipcRenderer.on('torrentsNotification', listener)

    aEx.on('error', async (err) => {
        loggerLaunchSuite.error('Error during launch', err)
        await LogsReporter.report(remote.app.getVersion()).catch(console.warn)
        showLaunchFailure('Error During Launch', err.message || 'See console (CTRL + Shift + i) for more details.')
        ipcRenderer.removeListener('torrentsNotification', listener)
    })
    aEx.on('close', async (code, signal) => {
        ipcRenderer.removeListener('torrentsNotification', listener)
        if (code === 0) {
            return
        }
        loggerLaunchSuite.error(`AssetExec exited with code ${code}, assuming error.`)
        await LogsReporter.report(remote.app.getVersion()).catch(console.warn)
        showLaunchFailure('Error During Launch', 'See console (CTRL + Shift + i) for more details.')
    })

    // Establish communications between the AssetExec and current process.
    aEx.on('message', async (m) => {
        if (m.context === 'torrents') {
            ipcRenderer.send.apply(ipcRenderer, ['torrents', ...m.args])
        } else if (m.context === 'validate') {
            switch (m.data) {
                case 'distribution':
                    setLaunchPercentage(20, 100)
                    loggerLaunchSuite.log('Validated distibution index.')
                    setLaunchDetails('Загрузка информации о версии игры..')
                    break
                case 'librariesInstall':
                    setLaunchPercentage(30, 100)
                    loggerLaunchSuite.log('Libraries Install Required!')
                    setLaunchDetails('Установка библиотек..')
                    break
                case 'version':
                    setLaunchPercentage(40, 100)
                    loggerLaunchSuite.log('Version data loaded.')
                    setLaunchDetails('Проверка целостности ресурсов..')
                    break
                case 'assets':
                    setLaunchPercentage(60, 100)
                    loggerLaunchSuite.log('Asset Validation Complete')
                    setLaunchDetails('Validating library integrity..')
                    break
                case 'libraries':
                    setLaunchPercentage(80, 100)
                    loggerLaunchSuite.log('Library validation complete.')
                    setLaunchDetails('Validating miscellaneous file integrity..')
                    break
                case 'files':
                    setLaunchPercentage(100, 100)
                    loggerLaunchSuite.log('File validation complete.')
                    setLaunchDetails('Скачивание игровых ресурсов..')
                    break
            }
        } else if (m.context === 'progress') {
            switch (m.data) {
                case 'validating': {
                    setDownloadPercentage(m.value, m.total, m.percent)
                    break
                }
                case 'assets': {
                    const perc = (m.value / m.total) * 20
                    setLaunchPercentage(40 + perc, 100, parseInt(40 + perc))
                    break
                }
                case 'download':
                    setDownloadPercentage(m.value, m.total, m.percent)
                    break
                case 'extract': {
                    // Show installing progress bar.
                    remote.getCurrentWindow().setProgressBar(2)

                    // Download done, extracting.
                    const eLStr = 'Extracting libraries'
                    let dotStr = ''
                    setLaunchDetails(eLStr)
                    progressListener = setInterval(() => {
                        if (dotStr.length >= 3) {
                            dotStr = ''
                        } else {
                            dotStr += '.'
                        }
                        setLaunchDetails(eLStr + dotStr)
                    }, 750)
                    break
                }
            }
        } else if (m.context === 'complete') {
            switch (m.data) {
                case 'download':
                    // Download and extraction complete, remove the loading from the OS progress bar.
                    remote.getCurrentWindow().setProgressBar(-1)
                    if (progressListener != null) {
                        clearInterval(progressListener)
                        progressListener = null
                    }

                    setLaunchDetails('Preparing to launch..')
                    break
            }
        } else if (m.context === 'error') {
            switch (m.data) {
                case 'download':
                    loggerLaunchSuite.error('Error while downloading:', m.error)

                    if (m.error.code === 'ENOENT') {
                        showLaunchFailure(
                            'Download Error',
                            'Could not connect to the file server. Ensure that you are connected to the internet and try again.'
                        )
                    } else {
                        showLaunchFailure(
                            'Download Error',
                            'Check the console (CTRL + Shift + i) for more details. Please try again.'
                        )
                    }

                    remote.getCurrentWindow().setProgressBar(-1)

                    // Disconnect from AssetExec
                    aEx.disconnect()
                    break
            }
        } else if (m.context === 'validateEverything') {

            if (typeof m.result.error === 'string' && m.result.error.startsWith('Required launcher version: ')) {
                const requiredLauncherVersion = m.result.error.replace('Required launcher version: ', '')

                showLaunchFailure(
                    'Требуется обновить лаунчер',
                    'Для запуска необходима более новая версия лаунчера. Пожалуйста обновитесь',
                    'Хорошо',
                    () => {
                        ipcRenderer.send('autoUpdateAction', 'installUpdateNow')
                        toggleOverlay(false)
                    }
                )
                switchView(getCurrentView(), VIEWS.settings, 500, 500, () => {
                    settingsNavItemListener(document.getElementById('settingsNavUpdate'), false)
                })
                aEx.disconnect()

                return
            }

            // Workaround for missing requirements
            if (m.result.error === 'Requirements missing') {
                showLaunchFailure(
                    Lang.queryJS('requirements.title'),
                    Lang.queryJS('requirements.desc'),
                    Lang.queryJS('requirements.accept')
                )
                aEx.disconnect()
                return
            }
            // If these properties are not defined it's likely an error.
            if (m.result.forgeData == null || m.result.versionData == null) {
                loggerLaunchSuite.error('Error during validation:', m.result.error)
                await LogsReporter.report(remote.app.getVersion()).catch(console.warn)
                showLaunchFailure('Error During Launch', 'Please check the console (CTRL + Shift + i) for more details.')

                aEx.disconnect()
                return
            }

            forgeData = m.result.forgeData
            versionData = m.result.versionData

            if (login) {
                const authUser = ConfigManager.getSelectedAccount()
                loggerLaunchSuite.log(`Sending selected account (${authUser.displayName}) to ProcessBuilder.`)
                pb = new ProcessBuilder(serv, versionData, forgeData, authUser, remote.app.getVersion())
                setLaunchDetails('Запуск игры..')

                const gameGlobalErrorListener = function (err) {
                    loggerLaunchSuite.error('Game launch failed', err)
                    showLaunchFailure('Error During Launch', 'To fix this issue, temporarily turn off your antivirus software and launch the game again.')
                    pb = null
                }

                try {
                    // Build Game process.
                    pb.addErrorListener(gameGlobalErrorListener).addCloseListener((code, signal) => {
                        toggleLaunchArea(false)
                        pb = null
                    })

                    // Init Discord Hook
                    const distro = DistroManager.getDistribution()
                    if (distro.discord != null && serv.discord != null) {
                        DiscordWrapper.initRPC(distro.discord, serv.discord)
                        hasRPC = true
                        pb.addCloseListener((code, signal) => {
                            loggerLaunchSuite.log('Shutting down Discord Rich Presence..')
                            DiscordWrapper.shutdownRPC()
                            hasRPC = false
                        })
                    }

                    pb.build()
                    setLaunchDetails('Клиент запущен, приятной игры!')
                    await LogsReporter.truncateLogs()
                    // await TorrentHolder.startSeeding()
                } catch (err) {
                    loggerLaunchSuite.error('Error during launch', err)
                    await LogsReporter.report(remote.app.getVersion()).catch(console.warn)
                    showLaunchFailure('Error During Launch', 'Please contact support.')
                }
            }

            // Disconnect from AssetExec
            aEx.disconnect()

        }
    })

    // Begin Validations

    // Validate Forge files.
    setLaunchDetails('Получение информации о сервере..')

    DistroManager.refresh()
        .then((data) => {
            return onDistroRefresh(data).then(() => {
                const channels = ConfigManager.getReleaseChannels()
                serv = data.getServer(ConfigManager.getSelectedServer(), channels)
                aEx.send({
                    task: 'execute',
                    function: 'validateEverything',
                    argsArr: [ConfigManager.getSelectedServer(), DistroManager.isDevMode()]
                })
            })
        }, (err) => {
            loggerLaunchSuite.error('Unable to refresh distribution index.', err)
            // Disconnect from AssetExec
            aEx.disconnect()
        })
}

/**
 * News Loading Functions
 */

// DOM Cache
const newsContent = document.getElementById('newsContent')
const newsArticleTitle = document.getElementById('newsArticleTitle')
const newsArticleDate = document.getElementById('newsArticleDate')
const newsArticleAuthor = document.getElementById('newsArticleAuthor')
const newsArticleComments = document.getElementById('newsArticleComments')
const newsNavigationStatus = document.getElementById('newsNavigationStatus')
const newsArticleContentScrollable = document.getElementById('newsArticleContentScrollable')
const nELoadSpan = document.getElementById('nELoadSpan')

// News slide caches.
let newsActive = false
let newsGlideCount = 0

/**
 * Show the news UI via a slide animation.
 *
 * @param {boolean} up True to slide up, otherwise false.
 */
function slide_(up) {
    const lCUpper = document.querySelector('#landingContainer > #upper')
    const lCLLeft = document.querySelector('#landingContainer > #lower > #left')
    const lCLCenter = document.querySelector('#landingContainer > #lower > #center')
    const lCLRight = document.querySelector('#landingContainer > #lower > #right')
    const newsBtn = document.querySelector('#landingContainer > #lower > #center #content')
    const landingContainer = document.getElementById('landingContainer')
    const newsContainer = document.querySelector('#landingContainer > #newsContainer')

    newsGlideCount++

    if (up) {
        lCUpper.style.top = '-200vh'
        lCLLeft.style.top = '-200vh'
        lCLCenter.style.top = '-200vh'
        lCLRight.style.top = '-200vh'
        newsBtn.style.top = '130vh'
        newsContainer.style.top = '0px'
        //date.toLocaleDateString('en-US', {month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: 'numeric'})
        //landingContainer.style.background = 'rgba(29, 29, 29, 0.55)'
        landingContainer.style.background = 'rgba(0, 0, 0, 0.50)'
        setTimeout(() => {
            if (newsGlideCount === 1) {
                lCLCenter.style.transition = 'none'
                newsBtn.style.transition = 'none'
            }
            newsGlideCount--
        }, 2000)
    } else {
        setTimeout(() => {
            newsGlideCount--
        }, 2000)
        landingContainer.style.background = null
        lCLCenter.style.transition = null
        newsBtn.style.transition = null
        newsContainer.style.top = '100%'
        lCUpper.style.top = '0px'
        lCLLeft.style.top = '0px'
        lCLCenter.style.top = '0px'
        lCLRight.style.top = '0px'
        newsBtn.style.top = '10px'
    }
}

// Bind news button.
document.getElementById('newsButton').onclick = () => {
    // Toggle tabbing.
    if (newsActive) {
        $('#landingContainer *').removeAttr('tabindex')
        $('#newsContainer *').attr('tabindex', '-1')
    } else {
        $('#landingContainer *').attr('tabindex', '-1')
        $('#newsContainer, #newsContainer *, #lower, #lower #center *').removeAttr('tabindex')
        if (newsAlertShown) {
            $('#newsButtonAlert').fadeOut(2000)
            newsAlertShown = false
            ConfigManager.setNewsCacheDismissed(true)
            ConfigManager.save()
        }
    }
    slide_(!newsActive)
    newsActive = !newsActive
}

// Array to store article meta.
let newsArr = null

// News load animation listener.
let newsLoadingListener = null

/**
 * Set the news loading animation.
 *
 * @param {boolean} val True to set loading animation, otherwise false.
 */
function setNewsLoading(val) {
    if (val) {
        const nLStr = 'Checking for News'
        let dotStr = '..'
        nELoadSpan.innerHTML = nLStr + dotStr
        newsLoadingListener = setInterval(() => {
            if (dotStr.length >= 3) {
                dotStr = ''
            } else {
                dotStr += '.'
            }
            nELoadSpan.innerHTML = nLStr + dotStr
        }, 750)
    } else {
        if (newsLoadingListener != null) {
            clearInterval(newsLoadingListener)
            newsLoadingListener = null
        }
    }
}

// Bind retry button.
newsErrorRetry.onclick = () => {
    $('#newsErrorFailed').fadeOut(250, () => {
        initNews()
        $('#newsErrorLoading').fadeIn(250)
    })
}

newsArticleContentScrollable.onscroll = (e) => {
    if (e.target.scrollTop > Number.parseFloat($('.newsArticleSpacerTop').css('height'))) {
        newsContent.setAttribute('scrolled', '')
    } else {
        newsContent.removeAttribute('scrolled')
    }
}

/**
 * Reload the news without restarting.
 *
 * @returns {Promise.<void>} A promise which resolves when the news
 * content has finished loading and transitioning.
 */
function reloadNews() {
    return new Promise((resolve, reject) => {
        $('#newsContent').fadeOut(250, () => {
            $('#newsErrorLoading').fadeIn(250)
            initNews().then(() => {
                resolve()
            })
        })
    })
}

let newsAlertShown = false

/**
 * Show the news alert indicating there is new news.
 */
function showNewsAlert() {
    newsAlertShown = true
    $(newsButtonAlert).fadeIn(250)
}

/**
 * Initialize News UI. This will load the news and prepare
 * the UI accordingly.
 *
 * @returns {Promise.<void>} A promise which resolves when the news
 * content has finished loading and transitioning.
 */
function initNews() {

    return new Promise((resolve, reject) => {
        setNewsLoading(true)

        let news = {}
        loadNews().then(news => {

            newsArr = news.articles || null

            if (newsArr == null) {
                // News Loading Failed
                setNewsLoading(false)

                $('#newsErrorLoading').fadeOut(250, () => {
                    $('#newsErrorFailed').fadeIn(250, () => {
                        resolve()
                    })
                })
            } else if (newsArr.length === 0) {
                // No News Articles
                setNewsLoading(false)

                ConfigManager.setNewsCache({
                    date: null,
                    content: null,
                    dismissed: false
                })
                ConfigManager.save()

                $('#newsErrorLoading').fadeOut(250, () => {
                    $('#newsErrorNone').fadeIn(250, () => {
                        resolve()
                    })
                })
            } else {
                // Success
                setNewsLoading(false)

                const lN = newsArr[0]
                const cached = ConfigManager.getNewsCache()
                let newHash = crypto.createHash('sha1').update(lN.content).digest('hex')
                let newDate = new Date(lN.date)
                let isNew = false

                if (cached.date != null && cached.content != null) {

                    if (new Date(cached.date) >= newDate) {

                        // Compare Content
                        if (cached.content !== newHash) {
                            isNew = true
                            showNewsAlert()
                        } else {
                            if (!cached.dismissed) {
                                isNew = true
                                showNewsAlert()
                            }
                        }

                    } else {
                        isNew = true
                        showNewsAlert()
                    }

                } else {
                    isNew = true
                    showNewsAlert()
                }

                if (isNew) {
                    ConfigManager.setNewsCache({
                        date: newDate.getTime(),
                        content: newHash,
                        dismissed: false
                    })
                    ConfigManager.save()
                }

                const switchHandler = (forward) => {
                    let cArt = parseInt(newsContent.getAttribute('article'))
                    let nxtArt = forward ? (cArt >= newsArr.length - 1 ? 0 : cArt + 1) : (cArt <= 0 ? newsArr.length - 1 : cArt - 1)

                    displayArticle(newsArr[nxtArt], nxtArt + 1)
                }

                document.getElementById('newsNavigateRight').onclick = () => {
                    switchHandler(true)
                }
                document.getElementById('newsNavigateLeft').onclick = () => {
                    switchHandler(false)
                }

                $('#newsErrorContainer').fadeOut(250, () => {
                    displayArticle(newsArr[0], 1)
                    $('#newsContent').fadeIn(250, () => {
                        resolve()
                    })
                })
            }

        })

    })
}

/**
 * Add keyboard controls to the news UI. Left and right arrows toggle
 * between articles. If you are on the landing page, the up arrow will
 * open the news UI.
 */
document.addEventListener('keydown', (e) => {
    if (newsActive) {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
            document.getElementById(e.key === 'ArrowRight' ? 'newsNavigateRight' : 'newsNavigateLeft').click()
        }
        // Interferes with scrolling an article using the down arrow.
        // Not sure of a straight forward solution at this point.
        // if(e.key === 'ArrowDown'){
        //     document.getElementById('newsButton').click()
        // }
    } else {
        if (getCurrentView() === VIEWS.landing) {
            if (e.key === 'ArrowUp') {
                document.getElementById('newsButton').click()
            }
        }
    }
})

/**
 * Display a news article on the UI.
 *
 * @param {Object} articleObject The article meta object.
 * @param {number} index The article index.
 */
function displayArticle(articleObject, index) {
    newsArticleTitle.innerHTML = articleObject.title
    newsArticleTitle.href = articleObject.link
    if (articleObject.author) {
        newsArticleAuthor.innerHTML = 'by ' + articleObject.author
        newsArticleAuthor.style.display = 'block'
    } else {
        newsArticleAuthor.style.display = 'none'
    }
    newsArticleDate.innerHTML = articleObject.date
    newsArticleComments.innerHTML = articleObject.comments
    newsArticleComments.href = articleObject.commentsLink
    newsArticleContentScrollable.innerHTML = '<div id="newsArticleContentWrapper"><div class="newsArticleSpacerTop"></div>' + articleObject.content + '<div class="newsArticleSpacerBot"></div></div>'
    Array.from(newsArticleContentScrollable.getElementsByClassName('bbCodeSpoilerButton')).forEach(v => {
        v.onclick = () => {
            const text = v.parentElement.getElementsByClassName('bbCodeSpoilerText')[0]
            text.style.display = text.style.display === 'block' ? 'none' : 'block'
        }
    })
    newsNavigationStatus.innerHTML = index + ' of ' + newsArr.length
    newsContent.setAttribute('article', index - 1)
}

/**
 * Load news information from the RSS feed specified in the
 * distribution index.
 */
function loadNews() {
    return new Promise((resolve, reject) => {
        const distroData = DistroManager.getDistribution()
        const newsFeed = distroData.getRSS()
        if (!newsFeed) {
            resolve({
                articles: null
            })
            return
        }
        const newsHost = new URL(newsFeed).origin + '/'
        $.ajax(
            {
                url: newsFeed,
                success: (data) => {
                    const items = $(data).find('item')
                    const articles = []

                    for (let i = 0; i < items.length; i++) {
                        // JQuery Element
                        const el = $(items[i])

                        // Resolve date.
                        const date = new Date(el.find('pubDate').text()).toLocaleDateString('en-US', {
                            month: 'short',
                            day: 'numeric',
                            year: 'numeric',
                            hour: 'numeric',
                            minute: 'numeric'
                        })

                        // Resolve comments.
                        let comments = el.find('slash\\:comments').text() || '0'
                        comments = comments + ' Comment' + (comments === '1' ? '' : 's')

                        // Fix relative links in content.
                        // let content = el.find('content\\:encoded').text()
                        let content = el.find('description').text()
                        let regex = /src="(?!http:\/\/|https:\/\/)(.+?)"/g
                        let matches
                        while ((matches = regex.exec(content))) {
                            content = content.replace(`"${matches[1]}"`, `"${newsHost + matches[1]}"`)
                        }

                        let link = el.find('link').text()
                        let title = el.find('title').text()
                        let author = el.find('dc\\:creator').text()

                        // Generate article.
                        articles.push(
                            {
                                link,
                                title,
                                date,
                                author,
                                content,
                                comments,
                                commentsLink: link + '#comments'
                            }
                        )
                    }
                    resolve({
                        articles
                    })
                },
                timeout: 2500
            }
        ).catch(err => {
            resolve({
                articles: null
            })
        })
    })
}
