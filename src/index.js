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

  // Reinstate first-page scrape → write connections.csv (robust selectors)
  // 1) Wait for results list presence (list items), fallback if needed
  let listItemSelector = 'ul[role="list"] > li';
  try {
    console.log('Waiting for results list...');
    await page.waitForSelector(listItemSelector, { timeout: 20000 });
  } catch {
    console.log('Fallback to chameleon result selector...');
    listItemSelector = 'div[data-chameleon-result-urn]';
    await page.waitForSelector(listItemSelector, { timeout: 20000 });
  }

  // 2) Scroll to load all first-page items
  console.log('Scrolling to load items...');
  await autoScroll(page);
  await new Promise(resolve => setTimeout(resolve, 1000));

  // 3) Scrape first 10 connections using span[dir="ltr"] → closest('a')
  console.log('Scraping first 10 connections...');
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

  console.log(`Collected ${connections.length} connections.`);
  
  // Save to master CSV with duplicate prevention
  const saveResult = saveConnectionsToMaster(connections, profileUrl, 1);
  console.log(`Page 1: ${saveResult.newConnections} new, ${saveResult.duplicateConnections} duplicates`);
  
  // Process emails for page 1 connections
  console.log('Processing emails for page 1 connections...');
  await processEmailsForPage(page, profileUrl, 1);

  // Navigate to page 2 and scrape next 10
  try {
    console.log('Revealing pagination...');
    await autoScroll(page);
    await new Promise(resolve => setTimeout(resolve, 800));

    // Capture the first result URN to detect list refresh
    let firstUrn = null;
    try {
      firstUrn = await page.$eval('div[data-chameleon-result-urn]', el => el.getAttribute('data-chameleon-result-urn'));
    } catch {}

    const paginationContainer = 'div.artdeco-pagination';
    const page2Button = 'li[data-test-pagination-page-btn="2"] > button';
    const nextButton = 'button.artdeco-pagination__button--next[aria-label="Next"]';

    console.log('Waiting for pagination controls...');
    await page.waitForSelector(paginationContainer, { timeout: 20000 });

    let clicked = false;
    try {
      await page.waitForSelector(page2Button, { timeout: 7000 });
      await page.click(page2Button);
      clicked = true;
      console.log('Clicked Page 2.');
    } catch {
      console.log('Page 2 button not directly available, trying Next...');
      await page.waitForSelector(nextButton, { timeout: 10000 });
      await page.click(nextButton);
      clicked = true;
      console.log('Clicked Next.');
    }

    if (clicked) {
      const prevUrl = page.url();
      await page.waitForFunction((prevUrn, prevUrl) => {
        const first = document.querySelector('div[data-chameleon-result-urn]');
        const currUrn = first ? first.getAttribute('data-chameleon-result-urn') : null;
        const url = window.location.href;
        const urlChanged = /[?&](page=2|start=\d+)/.test(url) && url !== prevUrl;
        return (currUrn && currUrn !== prevUrn) || urlChanged;
      }, { timeout: 20000 }, firstUrn, prevUrl);
      console.log('Detected result-set change for Page 2.');

      // Wait for results and scroll to load
      let listItemSelector2 = 'ul[role="list"] > li';
      try {
        await page.waitForSelector(listItemSelector2, { timeout: 20000 });
      } catch {
        listItemSelector2 = 'div[data-chameleon-result-urn]';
        await page.waitForSelector(listItemSelector2, { timeout: 20000 });
      }
      await autoScroll(page);
      await new Promise(resolve => setTimeout(resolve, 1000));

      console.log('Scraping Page 2 connections...');
      const connections2 = await page.$$eval(listItemSelector2, nodes => {
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

      console.log(`Collected ${connections2.length} connections from Page 2.`);
      
      // Save to master CSV with duplicate prevention
      const saveResult2 = saveConnectionsToMaster(connections2, profileUrl, 2);
      console.log(`Page 2: ${saveResult2.newConnections} new, ${saveResult2.duplicateConnections} duplicates`);

      // Process emails for page 2 connections
      console.log('Processing emails for page 2 connections...');
      await processEmailsForPage(page, profileUrl, 2);
    }
  } catch (err) {
    console.log('Page 2 navigation or scraping skipped due to error:', err?.message || err);
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

