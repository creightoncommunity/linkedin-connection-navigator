const puppeteer = require('puppeteer');
const path = require('path');
const { parse } = require('csv-parse/sync');

(async () => {
  const profileUrl = process.argv[2];
  if (!profileUrl || !profileUrl.startsWith('https://www.linkedin.com/in/')) {
    console.error('Please provide a valid LinkedIn profile URL as an argument.');
    console.error('Example: node src/index.js https://www.linkedin.com/in/davidbeer1/');
    return;
  }

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
  {
    const fs = require('fs');
    const header = 'Full Name,Profile URL,Current Employer\n';
    const body = connections.map(r => `"${r.fullName}","${r.profileUrl}","${r.currentEmployer}"`).join('\n');
    fs.writeFileSync('connections.csv', header + body);
    console.log('Saved connections.csv');
  }

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
      {
        const fs = require('fs');
        const header = 'Full Name,Profile URL,Current Employer\n';
        const body = connections2.map(r => `"${r.fullName}","${r.profileUrl}","${r.currentEmployer}"`).join('\n');
        fs.writeFileSync('connections_page2.csv', header + body);
        console.log('Saved connections_page2.csv');
      }

      // Process connections_page2.csv to extract emails via contact overlay
      try {
        const fs = require('fs');
        if (fs.existsSync('connections_page2.csv')) {
          console.log('Processing connections_page2.csv for emails...');
          const csvContent = fs.readFileSync('connections_page2.csv', 'utf-8');
          const rows = parse(csvContent, { columns: true, skip_empty_lines: true });

          // Re-open home to ensure hydration
          await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });
          await new Promise(r => setTimeout(r, 1200));

          const enriched = [];
          for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const base = row['Profile URL'].split('?')[0];
            const overlayUrl = `${base.endsWith('/') ? base : base + '/'}overlay/contact-info/`;
            console.log(`[${i + 1}/${rows.length}] ${overlayUrl}`);
            await page.goto(overlayUrl, { waitUntil: 'domcontentloaded' });
            await new Promise(r => setTimeout(r, 1500));

            let email = 'Not available';
            try {
              const mailtos = await page.$$eval('a[href^="mailto:"]', as => as.map(a => a.href));
              if (mailtos.length > 0) email = mailtos[0].replace('mailto:', '');
            } catch {}

            enriched.push({
              'Full Name': row['Full Name'],
              'Profile URL': row['Profile URL'],
              'Current Employer': row['Current Employer'],
              'Email': email,
            });

            await new Promise(r => setTimeout(r, 800 + Math.floor(Math.random() * 1000)));
          }

          const outHeader = 'Full Name,Profile URL,Current Employer,Email\n';
          const outBody = enriched.map(r => `"${r['Full Name']}","${r['Profile URL']}","${r['Current Employer']}","${r['Email']}"`).join('\n');
          fs.writeFileSync('connections_page2_with_emails.csv', outHeader + outBody);
          console.log('Saved connections_page2_with_emails.csv');
        }
      } catch (e) {
        console.log('Email enrichment for page 2 skipped due to error:', e?.message || e);
      }
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

