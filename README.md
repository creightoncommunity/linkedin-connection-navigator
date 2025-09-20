# LinkedIn Shared Connection Navigator

A LinkedIn scraping tool that retrieves email information from 1st degree connections shared with a starting profile.

## Current Functionality

The script currently performs the following operations:

1. **Authentication**: Uses Puppeteer with persistent session storage to maintain LinkedIn login
2. **Profile Navigation**: Navigates to a specified LinkedIn profile and accesses their connections
3. **Connection Filtering**: Filters to show only 1st degree shared connections
4. **Data Extraction**: Scrapes profile information including:
   - Full Name
   - Profile URL
   - Current Employer
5. **Pagination**: Currently handles page 1 and page 2 of connections
6. **Email Extraction**: For each connection, visits their contact overlay to extract email addresses
7. **CSV Output**: Creates separate CSV files for each page and email results

### Current File Structure
- `connections.csv` - Page 1 connections (name, profile URL, employer)
- `connections_page2.csv` - Page 2 connections
- `connections_with_emails.csv` - Page 1 connections with emails
- `connections_page2_with_emails.csv` - Page 2 connections with emails

## Planned Improvements

### 1. Unified Data Management
- **Master CSV**: Single `master_connections.csv` file for all profile captures
- **Duplicate Prevention**: Check for existing records before adding new ones
- **Append Logic**: Add new pages to existing master file instead of separate files

### 2. Progress Tracking & Resumability
- **Progress Markers**: Track current page and processing status in CSV
- **Resume Capability**: Resume from last successful page if execution breaks
- **Status Columns**: Add processing status indicators to track completion

### 3. Separated Email Processing
- **Email CSV**: Dedicated `connections_emails.csv` for email results
- **Easier Appends**: Simplified structure for adding new email discoveries
- **Cross-Reference**: Link emails back to master connections via profile URL

### 4. Improved Processing Flow
- **Page-by-Page**: Process one page of connections, then extract all emails for that page
- **Sequential Processing**: Page 1 → Page 1 emails → Page 2 → Page 2 emails, etc.
- **Complete Pagination**: Continue until all shared connections are processed

### 5. Cross-Profile Duplicate Detection
- **Global Deduplication**: When running on multiple profiles, detect and skip existing connections
- **Profile Tracking**: Track which profiles have been processed for each connection
- **Efficient Processing**: Avoid re-processing connections found in previous profile runs

### 6. Robust Navigation
- **Dynamic Pagination**: Handle any number of pages automatically
- **Error Recovery**: Graceful handling of navigation failures
- **Rate Limiting**: Appropriate delays to avoid being blocked

## Architecture Overview

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Profile URL   │ -> │   Navigation     │ -> │   Page Loop     │
│   (Input)       │    │   & Filtering    │    │   (All Pages)   │
└─────────────────┘    └──────────────────┘    └─────────────────┘
                                                         │
                                                         v
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│  Email CSV      │ <- │   Email          │ <- │   Connection    │
│  (Output)       │    │   Extraction     │    │   Scraping      │
└─────────────────┘    └──────────────────┘    └─────────────────┘
                                                         │
                                                         v
                                                ┌─────────────────┐
                                                │   Master CSV    │
                                                │   (Output)      │
                                                └─────────────────┘
```

## Usage

```bash
node src/index.js https://www.linkedin.com/in/profile-username/
```

The script will:
1. Navigate to the specified profile
2. Access their shared connections
3. Process all pages of 1st degree connections
4. Extract emails for each connection
5. Save results to master CSV files
6. Support resumable execution if interrupted

## Dependencies

- `puppeteer`: Web scraping and browser automation
- `csv-parse`: CSV file parsing for progress tracking
- `fs`: File system operations for CSV management

## File Outputs

- `master_connections.csv`: All connections with progress tracking
- `connections_emails.csv`: Email addresses for all connections
- `linkedin-session/`: Persistent browser session data
