
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

const parseTimestamp = (timestamp) => {
  const time = new Date(timestamp);
  const year = time.getFullYear();
  const month = String(time.getMonth() + 1).padStart(2, '0');
  const day = String(time.getDate()).padStart(2, '0');
  const hours = String(time.getHours()).padStart(2, '0');
  const minutes = String(time.getMinutes()).padStart(2, '0');

  const timeStr = `${year}-${month}-${day} ${hours}:${minutes}`;
  return timeStr;
}



const loadStoredData = async () => {
  const email = await getStoreData(storeConstants.EMAIL) || '';
  if (!email) return;

  document.getElementById('ads_email').value = email;
}

const storeData = async () => {
  const email = document.getElementById('ads_email').value || '';
  setStoreData(storeConstants.EMAIL, email);
}

const resetData = async () => {
  setStoreData(storeConstants.EMAIL, '');
  document.getElementById('ads_email').value = '';
}

const signinKDP = () => {
  chrome.tabs.create({ url: 'https://kdpreports.amazon.com/' });
}

const refreshSession = () => {
  chrome.browsingData.removeCookies({
    'origins': ['http://*.amazon.com/*', 'https://*.amazon.com/*', 'https://amazon.com/*', 'http://amazon.com/*']
  }, signinKDP);
}

const updateSigninStatus = (status) => {
  const signinEl = document.getElementById('ads_kdp_signin');
  const kdpEl = document.getElementById('ads_kdp_books');
  if (!signinEl || !kdpEl) return;
  if (status) {
    signinEl.classList.add('hide');
    kdpEl.classList.remove('hide');
  } else {
    signinEl.classList.remove('hide');
    kdpEl.classList.add('hide');
  }
}

const updateBooksList = (booksMetadata) => {
  const books = booksMetadata && booksMetadata.Books;
  if (!books) return;

  let booksHtml = ``;
  for (const book of books) {
    const author = escapeHtml(book.author);
    const bookName = escapeHtml(book.bookName);
    booksHtml += `
      <tr>
        <td>${author}</td>
        <td>${bookName}</td>
      </tr>
    `
  }
  if (!books.length) booksHtml = `<div class="table-row table-nodata">No Books found</div>`

  const booksBody = document.getElementById('books-body');
  booksBody.innerHTML = booksHtml;
}

const updateReportList = async () => {
  let reportHtml = ``;
  let initialReport = {};
  let dailyReport = {};

  try {
    const initialReportStr = await getStoreData(storeConstants.INITIAL_REPORT_STATUS) || '{}';
    const dailyReportStr = await getStoreData(storeConstants.DAILY_REPORT_STATUS) || '{}';

    initialReport = JSON.parse(initialReportStr);
    dailyReport = JSON.parse(dailyReportStr);
  } catch (exception) {
    logger.error(exception);
  }

  const makeHTMLRow = (type, range, status, timestamp) => {
    let statusClass = '', statusText;
    if (status === 'completed') {
      statusClass = 'status-success';
      statusText = 'Completed';
    }
    else {
      statusClass = 'status-failed';
      statusText = 'Failed';
    }

    return `
      <tr>
        <td>${type}</td>
        <td>${range} days</td>
        <td class="${statusClass}">${statusText}</td>
        <td>${parseTimestamp(timestamp)}</td>
      </tr>
    `
  }

  if (initialReport.status) {
    reportHtml += makeHTMLRow('Initial', initialReport.range || 90, initialReport.status, initialReport.updatedAt);
  }

  const dailyKeys = Object.keys(dailyReport).sort();
  for (const key of dailyKeys) {
    const report = dailyReport[key];
    if (!report || !report.status) return;
    reportHtml += makeHTMLRow('Daily', report.range || 14, report.status, report.updatedAt);
  }

  if (!reportHtml) {
    reportHtml = `<td colspan="4" class="text-center">No books found</td>`
  }

  const reportBody = document.getElementById('report-body');
  reportBody.innerHTML = reportHtml;
}

const addEventListenerById = (id, eventName, callback) => {
  const element = document.getElementById(id);
  if (!element) return false;
  element.addEventListener(eventName, callback);
}

const init = async () => {
  logger.log('popup init');
  loadStoredData();
  updateReportList();

  sendMessage({ type: messageConstants.REQ_INIT });

  addEventListenerById('ads_save', 'click', storeData);
  addEventListenerById('ads_reset', 'click', resetData);
  addEventListenerById('ads_refresh', 'click', refreshSession);
  addEventListenerById('ads_signout', 'click', refreshSession);
  addEventListenerById('ads_signin', 'click', signinKDP);
}

chrome.runtime.onMessage.addListener(
  async (request) => {
    const type = request?.type;
    if (type === messageConstants.RES_INIT) {
      const signinStatus = request.status;
      const booksMetadata = request.booksMetadata;
      updateSigninStatus(signinStatus);
      if (signinStatus) {
        updateBooksList(booksMetadata);
      }
    } else if (type === messageConstants.REQ_REFRESH_REPORT) {
      updateReportList();
    } else {
      logger.log('Unknown request type', request);
    }
  }
);

document.addEventListener('DOMContentLoaded', init);

// escapeHtml function can be used to sanitize any user input before it is added
function escapeHtml(unsafe) {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}