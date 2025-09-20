const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const { parse } = require('csv-parse/sync');

// CSV Management Functions
const MASTER_CSV = 'master_connections.csv';
const EMAIL_CSV = 'connections_emails.csv';

function loadExistingConnections() {
  if (!fs.existsSync(MASTER_CSV)) {
    return new Map();
  }
  
  const csvContent = fs.readFileSync(MASTER_CSV, 'utf-8');
  const rows = parse(csvContent, { columns: true, skip_empty_lines: true });
  const connectionMap = new Map();
  
  rows.forEach(row => {
    // Use the base profile URL (without query params) as the key for deduplication
    const baseUrl = row['Profile URL'].split('?')[0];
    connectionMap.set(baseUrl, {
      ...row,
      baseUrl
    });
  });
  
  return connectionMap;
}

function saveConnectionsToMaster(connections, startingProfileUrl, currentPage) {
  const existingConnections = loadExistingConnections();
  let newConnections = 0;
  let duplicateConnections = 0;
  
  connections.forEach(conn => {
    const baseUrl = conn.profileUrl.split('?')[0];
    
    if (!existingConnections.has(baseUrl)) {
      existingConnections.set(baseUrl, {
        'Full Name': conn.fullName,
        'Profile URL': conn.profileUrl,
        'Current Employer': conn.currentEmployer,
        'Base URL': baseUrl,
        'Source Profile': startingProfileUrl,
        'Page Found': currentPage,
        'Date Added': new Date().toISOString().split('T')[0],
        'Email Status': 'pending',
        'Processing Status': 'new'
      });
      newConnections++;
    } else {
      duplicateConnections++;
      console.log(`Duplicate found: ${conn.fullName} (${baseUrl})`);
    }
  });
  
  // Write all connections back to master CSV
  const header = 'Full Name,Profile URL,Current Employer,Base URL,Source Profile,Page Found,Date Added,Email Status,Processing Status\n';
  const rows = Array.from(existingConnections.values());
  const body = rows.map(r => 
    `"${r['Full Name']}","${r['Profile URL']}","${r['Current Employer']}","${r['Base URL']}","${r['Source Profile']}","${r['Page Found']}","${r['Date Added']}","${r['Email Status']}","${r['Processing Status']}"`
  ).join('\n');
  
  fs.writeFileSync(MASTER_CSV, header + body);
  
  console.log(`Master CSV updated: ${newConnections} new connections, ${duplicateConnections} duplicates skipped`);
  return { newConnections, duplicateConnections };
}

function getConnectionsToProcess() {
  if (!fs.existsSync(MASTER_CSV)) {
    return [];
  }
  
  const csvContent = fs.readFileSync(MASTER_CSV, 'utf-8');
  const rows = parse(csvContent, { columns: true, skip_empty_lines: true });
  
  return rows.filter(row => row['Email Status'] === 'pending');
}

function updateConnectionEmailStatus(baseUrl, email, status = 'completed') {
  if (!fs.existsSync(MASTER_CSV)) {
    return;
  }
  
  const csvContent = fs.readFileSync(MASTER_CSV, 'utf-8');
  const rows = parse(csvContent, { columns: true, skip_empty_lines: true });
  
  // Update the specific connection
  const updatedRows = rows.map(row => {
    if (row['Base URL'] === baseUrl) {
      return {
        ...row,
        'Email Status': status,
        'Processing Status': 'processed',
        'Last Processed': new Date().toISOString().split('T')[0]
      };
    }
    return row;
  });
  
  // Save back to master CSV with updated header to include Last Processed
  const header = 'Full Name,Profile URL,Current Employer,Base URL,Source Profile,Page Found,Date Added,Email Status,Processing Status,Last Processed\n';
  const body = updatedRows.map(r => 
    `"${r['Full Name']}","${r['Profile URL']}","${r['Current Employer']}","${r['Base URL']}","${r['Source Profile']}","${r['Page Found']}","${r['Date Added']}","${r['Email Status']}","${r['Processing Status']}","${r['Last Processed'] || ''}"`
  ).join('\n');
  
  fs.writeFileSync(MASTER_CSV, header + body);
  
  // Save email to separate CSV
  if (email && email !== 'Not available') {
    saveEmailToCSV(baseUrl, updatedRows.find(r => r['Base URL'] === baseUrl), email);
  }
}

function saveEmailToCSV(baseUrl, connectionData, email) {
  const emailEntry = {
    'Full Name': connectionData['Full Name'],
    'Profile URL': connectionData['Profile URL'],
    'Base URL': baseUrl,
    'Email': email,
    'Date Extracted': new Date().toISOString().split('T')[0],
    'Source Profile': connectionData['Source Profile']
  };
  
  let existingEmails = [];
  if (fs.existsSync(EMAIL_CSV)) {
    const csvContent = fs.readFileSync(EMAIL_CSV, 'utf-8');
    existingEmails = parse(csvContent, { columns: true, skip_empty_lines: true });
  }
  
  // Check if email already exists for this base URL
  const emailExists = existingEmails.some(e => e['Base URL'] === baseUrl);
  
  if (!emailExists) {
    existingEmails.push(emailEntry);
    
    const header = 'Full Name,Profile URL,Base URL,Email,Date Extracted,Source Profile\n';
    const body = existingEmails.map(e => 
      `"${e['Full Name']}","${e['Profile URL']}","${e['Base URL']}","${e['Email']}","${e['Date Extracted']}","${e['Source Profile']}"`
    ).join('\n');
    
    fs.writeFileSync(EMAIL_CSV, header + body);
    console.log(`Email saved for ${connectionData['Full Name']}: ${email}`);
  }
}

function getProgressInfo() {
  if (!fs.existsSync(MASTER_CSV)) {
    return { lastPage: 0, totalConnections: 0, processedEmails: 0 };
  }
  
  const csvContent = fs.readFileSync(MASTER_CSV, 'utf-8');
  const rows = parse(csvContent, { columns: true, skip_empty_lines: true });
  
  const lastPage = Math.max(...rows.map(r => parseInt(r['Page Found']) || 0));
  const totalConnections = rows.length;
  const processedEmails = rows.filter(r => r['Email Status'] === 'completed').length;
  
  return { lastPage, totalConnections, processedEmails };
}

async function processEmailsForPage(page, sourceProfile, pageNumber) {
  if (!fs.existsSync(MASTER_CSV)) {
    console.log('No master CSV found, skipping email processing');
    return;
  }
  
  const csvContent = fs.readFileSync(MASTER_CSV, 'utf-8');
  const rows = parse(csvContent, { columns: true, skip_empty_lines: true });
  
  // Filter for connections from this page that need email processing
  const connectionsToProcess = rows.filter(row => 
    row['Page Found'] === pageNumber.toString() && 
    row['Email Status'] === 'pending'
  );
  
  if (connectionsToProcess.length === 0) {
    console.log(`No pending email processing for page ${pageNumber}`);
    return;
  }
  
  console.log(`Processing emails for ${connectionsToProcess.length} connections from page ${pageNumber}`);
  
  // Re-open home to ensure hydration
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 1200));

  for (let i = 0; i < connectionsToProcess.length; i++) {
    const connection = connectionsToProcess[i];
    const baseUrl = connection['Base URL'];
    const overlayUrl = `${baseUrl.endsWith('/') ? baseUrl : baseUrl + '/'}overlay/contact-info/`;
    
    console.log(`[${i + 1}/${connectionsToProcess.length}] Processing: ${connection['Full Name']}`);
    console.log(`URL: ${overlayUrl}`);
    
    try {
      await page.goto(overlayUrl, { waitUntil: 'domcontentloaded' });
      await new Promise(r => setTimeout(r, 1500));

      let email = 'Not available';
      try {
        const mailtos = await page.$$eval('a[href^="mailto:"]', as => as.map(a => a.href));
        if (mailtos.length > 0) email = mailtos[0].replace('mailto:', '');
      } catch {}

      // Update the connection with email status
      updateConnectionEmailStatus(baseUrl, email);
      console.log(`Email for ${connection['Full Name']}: ${email}`);

    } catch (error) {
      console.log(`Error processing ${connection['Full Name']}: ${error.message}`);
      updateConnectionEmailStatus(baseUrl, 'Error', 'error');
    }

    // Add delay between requests
    await new Promise(r => setTimeout(r, 800 + Math.floor(Math.random() * 1000)));
  }
  
  console.log(`Completed email processing for page ${pageNumber}`);
}

async function scrapeConnectionsFromPage(page, listItemSelector) {
  // Scroll to load all items on current page
  console.log('Scrolling to load items...');
  await autoScroll(page);
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Scrape connections using the same logic as before
  console.log('Scraping connections...');
  const connections = await page.$$eval(listItemSelector, nodes => {
    const results = [];
    for (const item of nodes) {
      const nameContainer = item.querySelector('span[dir="ltr"]');
      if (!nameContainer) continue;
      const linkElement = nameContainer.closest('a');
      if (!linkElement) continue;
      const nameElement = nameContainer.querySelector('span[aria-hidden="true"]');
      const employerElement = item.querySelector('.t-14.t-normal, .entity-result__primary-subtitle');
      const fullName = nameElement ? nameElement.innerText.trim() : nameContainer.textContent.trim();
      const profileUrl = linkElement.href;
      const currentEmployer = employerElement ? employerElement.textContent.trim() : 'Not available';
      if (fullName && profileUrl) {
        results.push({ fullName, profileUrl, currentEmployer });
      }
      if (results.length >= 10) break;
    }
    return results;
  });
  
  return connections;
}

async function navigateToNextPage(page, currentPage) {
  try {
    console.log(`Attempting to navigate to page ${currentPage + 1}...`);
    
    // Scroll to reveal pagination
    await autoScroll(page);
    await new Promise(resolve => setTimeout(resolve, 800));

    // Capture the first result URN to detect list refresh
    let firstUrn = null;
    try {
      firstUrn = await page.$eval('div[data-chameleon-result-urn]', el => el.getAttribute('data-chameleon-result-urn'));
    } catch {}

    const paginationContainer = 'div.artdeco-pagination';
    const nextPageButton = `li[data-test-pagination-page-btn="${currentPage + 1}"] > button`;
    const nextButton = 'button.artdeco-pagination__button--next[aria-label="Next"]';

    console.log('Waiting for pagination controls...');
    await page.waitForSelector(paginationContainer, { timeout: 20000 });

    let clicked = false;
    
    // Try specific page button first
    try {
      await page.waitForSelector(nextPageButton, { timeout: 7000 });
      await page.click(nextPageButton);
      clicked = true;
      console.log(`Clicked page ${currentPage + 1} button.`);
    } catch {
      console.log(`Page ${currentPage + 1} button not found, trying Next button...`);
      try {
        await page.waitForSelector(nextButton, { timeout: 10000 });
        const isDisabled = await page.$eval(nextButton, el => el.disabled || el.getAttribute('aria-disabled') === 'true');
        if (isDisabled) {
          console.log('Next button is disabled, no more pages available');
          return false;
        }
        await page.click(nextButton);
        clicked = true;
        console.log('Clicked Next button.');
      } catch {
        console.log('No pagination controls found, likely on last page');
        return false;
      }
    }

    if (clicked) {
      const prevUrl = page.url();
      
      // Wait for the page content to change
      try {
        await page.waitForFunction((prevUrn, prevUrl, nextPage) => {
          const first = document.querySelector('div[data-chameleon-result-urn]');
          const currUrn = first ? first.getAttribute('data-chameleon-result-urn') : null;
          const url = window.location.href;
          const urlChanged = new RegExp('[?&](page=' + nextPage + '|start=\\d+)').test(url) && url !== prevUrl;
          return (currUrn && currUrn !== prevUrn) || urlChanged;
        }, { timeout: 20000 }, firstUrn, prevUrl, currentPage + 1);
        
        console.log(`Successfully navigated to page ${currentPage + 1}`);
        return true;
      } catch {
        console.log('Failed to detect page change');
        return false;
      }
    }
    
    return false;
  } catch (error) {
    console.log(`Error navigating to page ${currentPage + 1}: ${error.message}`);
    return false;
  }
}

(async () => {
  const profileUrl = process.argv[2];
  if (!profileUrl || !profileUrl.startsWith('https://www.linkedin.com/in/')) {
    console.error('Please provide a valid LinkedIn profile URL as an argument.');
    console.error('Example: node src/index.js https://www.linkedin.com/in/davidbeer1/');
    return;
  }

  // Show progress info
  const progressInfo = getProgressInfo();
  console.log(`\n=== Progress Summary ===`);
  console.log(`Total connections in master CSV: ${progressInfo.totalConnections}`);
  console.log(`Emails processed: ${progressInfo.processedEmails}`);
  console.log(`Last page processed: ${progressInfo.lastPage}`);
  console.log(`Starting profile: ${profileUrl}`);
  console.log(`======================\n`);

  const userDataDir = path.join(__dirname, '..', 'linkedin-session');
  const browser = await puppeteer.launch({
    headless: false,
    userDataDir: userDataDir
  });
  const page = await browser.newPage();
  await page.goto('https://www.linkedin.com/feed/');

  // Check if we are already logged in
  const isLoggedIn = await page.$('#global-nav') !== null;

  if (!isLoggedIn) {
    console.log('You are not logged in. Please log in to LinkedIn...');
    await page.goto('https://www.linkedin.com/login');
    console.log('Please log in to LinkedIn and then press any key to continue...');
    await new Promise(resolve => process.stdin.once('data', resolve));
  } else {
    console.log('You are already logged in.');
  }

  // After login, navigate to the profile page first
  await page.goto(profileUrl);
  console.log(`Navigated to profile page for ${profileUrl}`);

  // Click the connections link
  console.log('Finding and clicking connections link...');
  const connectionsLinkSelector = 'a[href*="/search/results/people/?connectionOf="]';
  await page.waitForSelector(connectionsLinkSelector);
  
  // Click and wait for navigation to complete
  await Promise.all([
    page.waitForNavigation(),
    page.click(connectionsLinkSelector),
  ]);
  
  console.log('Navigated to connections page. Now filtering for 1st degree connections...');

  // Get current URL and filter for 1st degree connections
  const currentUrl = page.url();
  const urlObject = new URL(currentUrl);
  const networkParam = urlObject.searchParams.get('network');
  let needsNavigating = false;

  if (networkParam) {
    try {
      // LinkedIn uses a URI encoded string for the network param, but it's essentially a JSON array
      const network = JSON.parse(decodeURIComponent(networkParam));
      // If the results include 2nd degree (S) or are not just 1st degree (F), filter it.
      if (network.includes('S') || network.length > 1) { 
        urlObject.searchParams.set('network', '["F"]'); // Corrected: Do not double-encode
        needsNavigating = true;
      }
    } catch (e) {
      console.error('Could not parse network param:', networkParam, e);
    }
  }

  if (needsNavigating) {
    const filteredUrl = urlObject.toString();
    console.log(`Filtering URL to: ${filteredUrl}`);
    await page.goto(filteredUrl);
    console.log('Navigated to filtered connections page.');
  } else {
    console.log('Already showing 1st degree connections.');
  }

  // Dynamic pagination loop - process all available pages
  console.log('Starting dynamic pagination loop...');
  
  // Determine list item selector
  let listItemSelector = 'ul[role="list"] > li';
  try {
    console.log('Waiting for results list...');
    await page.waitForSelector(listItemSelector, { timeout: 20000 });
  } catch {
    console.log('Fallback to chameleon result selector...');
    listItemSelector = 'div[data-chameleon-result-urn]';
    await page.waitForSelector(listItemSelector, { timeout: 20000 });
  }

  let currentPage = 1;
  let hasMorePages = true;
  
  while (hasMorePages) {
    console.log(`\n=== Processing Page ${currentPage} ===`);
    
    // Scrape connections from current page
    const connections = await scrapeConnectionsFromPage(page, listItemSelector);
    console.log(`Collected ${connections.length} connections from page ${currentPage}.`);
    
    if (connections.length === 0) {
      console.log('No connections found on this page, stopping pagination');
      break;
    }
    
    // Save to master CSV with duplicate prevention
    const saveResult = saveConnectionsToMaster(connections, profileUrl, currentPage);
    console.log(`Page ${currentPage}: ${saveResult.newConnections} new, ${saveResult.duplicateConnections} duplicates`);
    
    // Process emails for current page connections
    console.log(`Processing emails for page ${currentPage} connections...`);
    await processEmailsForPage(page, profileUrl, currentPage);
    
    // Try to navigate to next page
    hasMorePages = await navigateToNextPage(page, currentPage);
    
    if (hasMorePages) {
      currentPage++;
      
      // Wait for new page to load and update selector if needed
      try {
        await page.waitForSelector(listItemSelector, { timeout: 20000 });
      } catch {
        listItemSelector = 'div[data-chameleon-result-urn]';
        await page.waitForSelector(listItemSelector, { timeout: 20000 });
      }
    } else {
      console.log(`\nCompleted processing all pages. Total pages processed: ${currentPage}`);
    }
  }

  console.log('Attempting to capture page content for debugging...');
  
  // Wait for the main content area to be reasonably loaded
  await new Promise(resolve => setTimeout(resolve, 5000));

  try {
    const mainContentSelector = '.scaffold-layout__content--main';
    await page.waitForSelector(mainContentSelector, { timeout: 10000 });
    const mainContentHtml = await page.$eval(mainContentSelector, element => element.innerHTML);
    
    const fs = require('fs');
    fs.writeFileSync('debug.html', mainContentHtml);
    console.log(`HTML content of the main content area saved to debug.html`);
  } catch (e) {
    console.error('Could not find the main content area. Dumping the whole page body instead.');
    const bodyHtml = await page.evaluate(() => document.body.innerHTML);
    const fs = require('fs');
    fs.writeFileSync('debug.html', bodyHtml);
    console.log('Full body HTML saved to debug.html. Please inspect this file.');
  }
  
  await browser.close();
})();
async function autoScroll(page){
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      var totalHeight = 0;
      var distance = 100;
      var timer = setInterval(() => {
        var scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;

        if(totalHeight >= scrollHeight - window.innerHeight){
          clearInterval(timer);
          resolve();
        }
      }, 200); // Slower scroll
    });
  });
}

