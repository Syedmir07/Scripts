const axios = require('axios');
const fs = require('fs');
const readline = require('readline');

// --- CONFIGURATION ---
const FILTER_URL = 'https://api.yocket.com/connect/filter/v2/8f3f2602-df6b-4ec5-ac95-2b54a260f433';
const PROFILE_BASE_URL = 'https://api.yocket.com/users/profile/';
const DATA_FILE = 'full_detailed_profiles.jsonl';
const CHECKPOINT_FILE = 'scraper_checkpoint.json';
const FAILED_USERS_FILE = 'failed_usernames.txt';
const DELAY_BETWEEN_PROFILES = 500; // 1 second per profile to avoid bans

let CURRENT_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhbGdvcml0aG0iOiJFUzI1NiIsImlkIjoiOGYzZjI2MDItZGY2Yi00ZWM1LWFjOTUtMmI1NGEyNjBmNDMzIiwiaWF0IjoxNzc3MzQ3MDY2LCJleHAiOjE3ODUxNzY4MTJ9.HE_IFwwsjmfMLns27arU2XmkXr0XjFalc9sJBHhm0hw';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function promptNewToken() {
    return new Promise((resolve) => {
        console.log("\n⚠️  TOKEN EXPIRED (401 Unauthorized)!");
        rl.question("Paste new Bearer Token: ", (newToken) => resolve(newToken.trim()));
    });
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function scrape() {
    // Load Checkpoint
    let state = { page: 1, userIndex: 0 };
    if (fs.existsSync(CHECKPOINT_FILE)) {
        state = JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf8'));
        console.log(`Resuming from Page ${state.page}, User Index ${state.userIndex}`);
    }

    for (let p = state.page; p <= 39000; p++) {
        let usernames = [];
        
        // 1. Fetch the list of users on this page
        try {
            console.log(`\n--- Fetching Page ${p} ---`);
            const listRes = await axios.get(FILTER_URL, {
                params: { page: p, items: 9, country_id: 1, level: 2 },
                headers: { 'authorization': `Bearer ${CURRENT_TOKEN}` }
            });
            usernames = listRes.data.data.results.map(r => r.username);
        } catch (err) {
            if (err.response?.status === 401) {
                if (process.env.CI || process.env.GITHUB_ACTIONS) {
                    console.error("Token expired during list fetch in CI. Exiting to commit current data.");
                    process.exit(1);
                } else {
                    CURRENT_TOKEN = await promptNewToken();
                    p--; // Repeat this page
                    continue;
                }
            }
            console.error("List Fetch Error:", err.message);
            await sleep(5000);
            p--; continue;
        }

        // 2. Fetch details for each username
        for (let i = state.userIndex; i < usernames.length; i++) {
            const username = usernames[i];
            let success = false;
            let retryCount = 0;
            const maxRetries = 3; // Maximum retries for non-401 errors

            while (!success) {
                try {
                    console.log(`[Page ${p}] [User ${i+1}/9] Fetching: ${username}...`);
                    const profileRes = await axios.get(`${PROFILE_BASE_URL}${username}`, {
                        headers: { 'authorization': `Bearer ${CURRENT_TOKEN}` }
                    });

                    // Append full data to JSONL
                    fs.appendFileSync(DATA_FILE, JSON.stringify(profileRes.data.data) + '\n');
                    
                    // Update checkpoint
                    state.userIndex = i + 1;
                    fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify({ page: p, userIndex: i + 1 }));
                    
                    success = true;
                    // await sleep(DELAY_BETWEEN_PROFILES);

                } catch (err) {
                    if (err.response?.status === 401) {
                        if (process.env.CI || process.env.GITHUB_ACTIONS) {
                            console.error("Token expired during profile fetch in CI. Exiting to commit current data.");
                            process.exit(1);
                        } else {
                            CURRENT_TOKEN = await promptNewToken();
                        }
                    } else if (err.response?.status === 404) {
                        console.log(`User ${username} not found (404). Skipping.`);
                        success = true; 
                    } else {
                        retryCount++;
                        if (retryCount >= maxRetries) {
                            console.log(`Max retries reached for ${username}. Skipping and logging to failed file.`);
                            fs.appendFileSync(FAILED_USERS_FILE, username + '\n');
                            success = true;
                        } else {
                            console.log(`Error fetching ${username}: ${err.message}. Retrying in 10s...`);
                            await sleep(10000);
                        }
                    }
                }
            }
        }

        // Reset user index for the next page
        state.userIndex = 0;
        fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify({ page: p + 1, userIndex: 0 }));
    }
}

scrape().catch(console.error);