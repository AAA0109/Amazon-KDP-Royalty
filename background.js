
const INITIAL_REPORT_RANGE = 90;
const DAILY_REPORT_RANGE = 14;

const MAXIMUM_RULE_ID = 999999999;
const MAXIMUM_FAILED_RETRY_COUNT = 1;

const AMAZON_KDP_BASE_URL = 'https://kdpreports.amazon.com'
const AMAZON_CUSTOMER_METADATA_URL = `${AMAZON_KDP_BASE_URL}/api/v2/reports/customerMetadata`;
const AMAZON_BOOKS_METADATA_URL = `${AMAZON_KDP_BASE_URL}/api/v2/reports/booksMetadata`;
const AMAZON_KDP_ROYALTIES_URL = `${AMAZON_KDP_BASE_URL}/reports/royalties`;
const AMAZON_KDP_ROYALTIES_READY_URL = `${AMAZON_KDP_BASE_URL}/api/v2/reports/pagesReadByAsin`;
const AMAZON_KDP_ROYALTIES_REPORT_URL = `${AMAZON_KDP_BASE_URL}/download/report/royaltiesestimator/en_US/royaltiesEstimatorReport.xslx`;

const UPLOAD_URL = 'http://localhost:8000/api/report/royalties/';

const messageConstants = {
    REQ_INIT: 'req_init',
    REQ_REFRESH_REPORT: 'req_report_refresh',
    RES_INIT: 'res_init',
}

const storeConstants = {
    INITIAL_REPORT_STATUS: 'ads_initial_report_status',
    DAILY_REPORT_STATUS: 'ads_daily_report_status',
    EMAIL: 'ads_email'
}

const logger = {
    log: (...params) => {
        console.log(...params);
    },
    error: (...params) => {
        console.error(...params);
    },
    info: (...params) => {
        console.info(...params);
    }
}

const sendMessage = data => {
    return new Promise(resolve => {
        chrome.runtime.sendMessage(data, response => {
            resolve(response);
        });
    });
}


const getStoreData = (key) => {
    return new Promise(resolve => {
        chrome.storage.local.get(key, result => {
            resolve(result && result[key]);
        })
    });
}

const setStoreData = (key, value) => {
    return new Promise(resolve => {
        chrome.storage.local.set({ [key]: value }, result => {
            resolve(result);
        });
    })
}

const getRandomId = (min, max) => {
    const range = max - min + 1;

    if (crypto && crypto.getRandomValues) {
        const byteArray = new Uint32Array(1);
        crypto.getRandomValues(byteArray);
        const maxRange = Math.pow(2, 32) - 1;
        const randomNumber = byteArray[0] / maxRange * range + min;
        return Math.floor(randomNumber);
    }
    return Math.floor(Math.random() * range + min);
}

const setKpdReportInterceptor = () => {
    logger.log('Setting Report Interceptor...');
    const refererUrl = `${AMAZON_KDP_BASE_URL}/`;
    const originUrl = AMAZON_KDP_BASE_URL;
    const ruleId = getRandomId(0, MAXIMUM_RULE_ID);
    chrome.declarativeNetRequest.updateDynamicRules({
        addRules: [{
            'id': ruleId,
            'priority': 1,
            'action': {
                'type': 'modifyHeaders',
                'requestHeaders': [
                    { 'header': 'Referer', 'operation': 'set', 'value': refererUrl },
                    { 'header': 'Origin', 'operation': 'set', 'value': originUrl },
                ]
            },
            'condition': {
                'urlFilter': refererUrl,
            }
        }]
    });
}



const makeAmazonRequest = async (url, httpMethod, data, headers, acceptableStatuses) => {
    if (!headers) {
        headers = {};
    }
    try {
        const response = await fetch(url, {
            method: httpMethod,
            headers: headers,
            body: data,
            credentials: 'include',
        });
        const responseHeaders = response.headers;
        for (const header in responseHeaders) {
            'Set-Cookie' === header && console.info('Found set cookie header');
        };
        const responseURL = response.url; // the request URL after any redirects
        if (responseURL.includes('signin')) {
            console.warn('Requires Amazon reauthentication');
            return undefined;
        } else {
            return response;
        }
    } catch (failedRequest) {
        logger.error('Failed makeAmazonRequest', url, httpMethod);
        logger.error(failedRequest);
        if (acceptableStatuses && failedRequest && failedRequest.response && acceptableStatuses.includes(failedRequest.response.status)) {
            return failedRequest.response;
        }
        if (failedRequest && failedRequest.response && failedRequest.response.status === 401) {
            throw (console.warn('Requires Amazon reauthentication 401'), 'Requires amazon reauth 401');
        }
    }
}

const getCommonRequestParams = (csrf) => {
    if (!csrf) {
        throw new Error('CSRF token not set');
    }

    const headers = {
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'X-Csrf-Token': csrf,
        'X-Requested-With': 'XMLHttpRequest'
    };
    return {
        method: 'GET',
        headers: headers,
        credentials: 'include',
    }
}

const getMetaData = async (csrf, url) => {
    if (!csrf) {
        throw new Error('CSRF token not set');
    }

    try {
        const response = await fetch(url, getCommonRequestParams(csrf));
        const responseURL = response.url; // the request URL after any redirects
        if (responseURL.toLowerCase().includes('signin')) {
            return undefined;
        } else {
            return response.json();
        }
    } catch (error) {
        logger.error(`Could not get metadata: ${error}`);
        return undefined;
    }
}

const getCustomerMetadata = async (csrf) => {
    return await getMetaData(csrf, AMAZON_CUSTOMER_METADATA_URL);
}

const getBooksMetadata = async (csrf) => {
    return await getMetaData(csrf, AMAZON_BOOKS_METADATA_URL);
}

const getBookAsins = async (csrf) => {
    const booksMetadata = await getBooksMetadata(csrf);
    logger.log('Books', booksMetadata);
    if (!booksMetadata || !booksMetadata.Books) {
        logger.error('Failed to get Book asins');
        return '';
    }
    const asins = booksMetadata.Books?.map(b => b.ASIN).join(',');
    return asins;
}

const retrieveCsrfToken = async () => {
    try {
        const response = await makeAmazonRequest(AMAZON_KDP_ROYALTIES_URL, 'GET', null, undefined, undefined, false);
        const csrf = (await response.text())?.split('csrftoken":{"token":"')[1]?.split('"')[0];
        return csrf;
    } catch (error) {
        logger.error(`Could not retrieve CSRF: ${error}`);
        return undefined;
    }
}

const getInitialStatus = async () => {
    const csrf = await retrieveCsrfToken();
    let booksMetadata = null;
    if (csrf) booksMetadata = await getBooksMetadata(csrf);

    return {
        status: !!csrf,
        booksMetadata
    }
}

const getReportUrl = async (startDate, endDate) => {
    const url = AMAZON_KDP_ROYALTIES_REPORT_URL;
    const response = await makeAmazonRequest(url, 'POST', JSON.stringify({
        asins: null,
        authors: null,
        distribution: null,
        formats: null,
        marketplaces: null,
        reportEndDate: endDate,
        reportGranularity: 'DAY',
        reportStartDate: startDate,
        reportType: 'royalties'
    }), {
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'Content-Type': 'application/json',
    }, undefined, false);

    try {
        const data = await response.json();
        return data.url;
    } catch (err) {
        logger.error('Failed getReportUrl', err);
    }
}

const makePageReady = async (startDate, endDate, csrf) => {
    try {
        const asins = await getBookAsins(csrf);

        const url = AMAZON_KDP_ROYALTIES_READY_URL;
        const requestParams = `?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}&granularity=DAY&asins=${encodeURIComponent(asins)}`;
        await fetch(url + requestParams, getCommonRequestParams(csrf));
    } catch (error) {
        logger.error(`Could not get customer metadata: ${error}`);
        return undefined;
    }
}

const getTimeRange = (period) => {
    const endDate = new Date();
    endDate.setUTCHours(23, 59, 59);
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - period + 1);
    startDate.setUTCHours(0, 0, 0);

    let startString = startDate.toISOString(), endString = endDate.toISOString();
    startString = startString.slice(0, 19) + 'Z';
    endString = endString.slice(0, 19) + 'Z';

    return { startDate: startString, endDate: endString };
}

const getLatestReportUrl = async (period = 7) => {
    let returnUrl = '', retryCount = 0;
    const maxRetryCount = MAXIMUM_FAILED_RETRY_COUNT;

    try {
        const csrf = await retrieveCsrfToken();
        const { startDate, endDate } = getTimeRange(period);

        do {
            await makePageReady(startDate, endDate, csrf);
            returnUrl = await getReportUrl(startDate, endDate);
            await new Promise(resolve => setTimeout(resolve, 500));
        } while (!returnUrl && retryCount++ < maxRetryCount)
    } catch (err) {
        logger.error('Failed getLatestReportUrl', err);
        return '';
    }

    logger.log(period + 'days report url', returnUrl);
    return returnUrl;
}

const getAccountCreationDateFromCustomerMetadata = async (customerMetadata) => {
    const accountCreationDateInfo = customerMetadata.accountCreationDate.split('-');
    const year = accountCreationDateInfo[0];
    const month = accountCreationDateInfo[1];
    return new Date(Date.UTC(parseInt(year), parseInt(month))); // We only care about the year and month.
}

const downloadFileAsBlob = async (url) => {
    try {
        const response = await fetch(url);
        const blob = await response.blob();
        logger.log(blob, blob.url);
        return blob;
    } catch (exception) {
        logger.error(exception);
    }
}

const uploadFile = async (blob) => {
    try {
        const email = await getStoreData(storeConstants.EMAIL);
        if (!email) return;

        const formData = new FormData();
        formData.append('file', blob, 'report.xlsx');
        formData.append('email', email)

        const uploadResponse = await fetch(UPLOAD_URL, {
            method: 'POST',
            body: formData
        });

        if (uploadResponse.ok) {
            logger.log('upload success');
            return true;
        } else {
            logger.log('upload failed');
        }
    } catch (exception) {
        logger.error('Failed uploadFile', exception);
    }
    return false;
}

const updateReportStatus = async (key, data) => {
    await setStoreData(key, JSON.stringify(data));
    sendMessage({ type: messageConstants.REQ_REFRESH_REPORT });
}

const fetchAndUploadReport = async (period) => {
    const reportUrl = await getLatestReportUrl(period);
    if (!reportUrl) return 'failed_fetch_url';

    const blob = await downloadFileAsBlob(reportUrl);
    if (!blob) return 'failed_download';
    
    const uploadStatus = await uploadFile(blob);
    if (!uploadStatus) return 'failed_upload';

    return 'completed';
}

const check90daysReport = async () => {
    const reportStatusStr = await getStoreData(storeConstants.INITIAL_REPORT_STATUS) || '{}';
    let reportStatus = {};
    try {
        reportStatus = JSON.parse(reportStatusStr);
    } catch (exception) {
        logger.error('Failed parsing', exception);
    }

    if (reportStatus.status === 'completed') return;

    const status = await fetchAndUploadReport(INITIAL_REPORT_RANGE);
    const retryCount = reportStatus && reportStatus.retryCount || 0;
    await updateReportStatus(storeConstants.INITIAL_REPORT_STATUS, {
        status,
        retryCount: retryCount + 1,
        range: INITIAL_REPORT_RANGE,
        updatedAt: Date.now()
    })
}

const checkDailyReport = async () => {
    const reportStatusStr = await getStoreData(storeConstants.DAILY_REPORT_STATUS) || '{}';
    let reportStatus = {};
    try {
        reportStatus = JSON.parse(reportStatusStr);
    } catch (exception) {
        logger.error('Failed parsing', exception);
    }
    const today = new Date().toISOString().substring(0, 10);

    const todayReportStatus = reportStatus[today];
    if (todayReportStatus && todayReportStatus.status === 'completed') return;

    const status = await fetchAndUploadReport(DAILY_REPORT_RANGE);
    const retryCount = todayReportStatus && todayReportStatus.retryCount || 0;

    reportStatus[today] = {
        status,
        retryCount: retryCount + 1,
        range: DAILY_REPORT_RANGE,
        updatedAt: Date.now()
    }
    await updateReportStatus(storeConstants.DAILY_REPORT_STATUS, reportStatus)
}

const regularCheck = async () => {
    const email = await getStoreData(storeConstants.EMAIL);
    if (!email) return;

    await Promise.all([check90daysReport(), checkDailyReport()]);
}

const init = async () => {
    logger.log('initialize...');
    setKpdReportInterceptor();
    setTimeout(regularCheck, 4000);

    const CHECK_RATE = 10 * 60 * 1000;
    setInterval(regularCheck, CHECK_RATE);
}


init();




chrome.runtime.onMessage.addListener(
    async function (request, sender, sendResponse) {
        const type = request?.type;
        if (type === messageConstants.REQ_INIT) {
            try {
                const { status, booksMetadata } = await getInitialStatus();
                sendMessage({ type: messageConstants.RES_INIT, status, booksMetadata });
            } catch (exception) {
                logger.error('Failed initialization', exception);
            }
        } else {
            logger.error('Unknown request type', request);
        }
    }
);
