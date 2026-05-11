const axios = require('axios');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ================= CONFIG =================

const FILTER_URL =
    'https://api.yocket.com/connect/filter/v2/8f3f2602-df6b-4ec5-ac95-2b54a260f433';

const PROFILE_BASE_URL =
    'https://api.yocket.com/users/profile/';

const MAX_PAGES = 39000;

const PAGES_PER_FILE = 4000;

const DELAY_BETWEEN_PROFILES = 500;

const MAX_RUNTIME = 5.5 * 60 * 60 * 1000;

const START_TIME = Date.now();

let CURRENT_TOKEN = process.env.YOCKET_TOKEN || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhbGdvcml0aG0iOiJFUzI1NiIsImlkIjoiOGYzZjI2MDItZGY2Yi00ZWM1LWFjOTUtMmI1NGEyNjBmNDMzIiwiaWF0IjoxNzc4NDA5NDg3LCJleHAiOjE3ODYyMzkyMzN9.8sULqqdz6EsZNBxF-ZiG0vfT61R2ON5ZxONKMkZOrv8";


// Start from any page:
// node scraper.js 12000
const CLI_ARG = process.argv[2];
let START_PAGE = 1;
let START_USER_INDEX = 0;

if (CLI_ARG) {
    // CLI argument takes precedence
    START_PAGE = Number(CLI_ARG);
    if (!isNaN(START_PAGE) && START_PAGE > 0) {
        console.log(`📍 Starting from page ${START_PAGE} (CLI argument)`);
    } else {
        console.warn(`Invalid page number: ${CLI_ARG}, defaulting to 1`);
        START_PAGE = 1;
    }
} else {
    // Try to load scraper checkpoint if no CLI arg
    const CHECKPOINT_FILE = path.join(__dirname, 'scraper_checkpoint.json');
    if (fs.existsSync(CHECKPOINT_FILE)) {
        try {
            const checkpoint = JSON.parse(
                fs.readFileSync(CHECKPOINT_FILE, 'utf8')
            );
            if (checkpoint.page && checkpoint.page > 0) {
                START_PAGE = checkpoint.page;
                START_USER_INDEX = checkpoint.userIndex || 0;
                console.log(`📍 Loaded checkpoint: starting from page ${START_PAGE}, user index ${START_USER_INDEX}`);
            }
        } catch (err) {
            console.warn('Could not load checkpoint, defaulting to page 1');
            START_PAGE = 1;
        }
    } else {
        console.log(`📍 No checkpoint found, starting from page 1`);
    }
}

// ================= PATHS =================

const DATA_DIR = path.join(__dirname, 'data');
const META_DIR = path.join(__dirname, 'meta');
const FAILED_DIR = path.join(__dirname, 'failed');

const SCRAPER_CHECKPOINT_FILE =
    path.join(__dirname, 'scraper_checkpoint.json');

const FAILED_USERS_FILE =
    path.join(FAILED_DIR, 'failed_users.txt');

// ================= SETUP =================

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(META_DIR, { recursive: true });
fs.mkdirSync(FAILED_DIR, { recursive: true });

const IS_INTERACTIVE =
    process.stdin.isTTY && process.stdout.isTTY;

const IS_CI =
    Boolean(process.env.CI || process.env.GITHUB_ACTIONS);

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// ================= HELPERS =================

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isTimeUp() {
    return Date.now() - START_TIME > MAX_RUNTIME;
}

function getBatchFile(page) {
    const start =
        Math.floor((page - 1) / PAGES_PER_FILE) *
            PAGES_PER_FILE +
        1;

    const end = start + PAGES_PER_FILE - 1;

    return path.join(
        DATA_DIR,
        `batch_${start}_${end}.jsonl`
    );
}

function saveCheckpoint(page, userIndex = 0) {
    fs.writeFileSync(
        SCRAPER_CHECKPOINT_FILE,
        JSON.stringify({ page, userIndex }, null, 2)
    );
}

function logFailedUser(username) {
    fs.appendFileSync(
        FAILED_USERS_FILE,
        `${username}\n`
    );
}

function promptNewToken() {
    if (!IS_INTERACTIVE) {
        throw new Error(
            'Token expired in non-interactive environment.'
        );
    }

    return new Promise(resolve => {
        console.log('\n⚠️ TOKEN EXPIRED (401)');
        rl.question(
            'Paste new Bearer Token: ',
            token => resolve(token.trim())
        );
    });
}

// ================= MAIN =================

async function scrape() {
    for (let p = START_PAGE; p <= MAX_PAGES; p++) {
        if (isTimeUp()) {
            console.log(
                '\n⏳ Max runtime reached. Exiting safely.'
            );
            return;
        }

        console.log(
            `\n================ PAGE ${p} ================`
        );

        let usernames = [];

        // ================= FETCH USER LIST =================

        try {
            const listRes = await axios.get(FILTER_URL, {
                params: {
                    page: p,
                    items: 9,
                    country_id: 1,
                    level: 2
                },
                headers: {
                    authorization: `Bearer ${CURRENT_TOKEN}`
                }
            });

            usernames =
                listRes.data?.data?.results?.map(
                    r => r.username
                ) || [];

            console.log(
                `Found ${usernames.length} usernames`
            );
        } catch (err) {
            if (err.response?.status === 401) {
                if (IS_CI || !IS_INTERACTIVE) {
                    console.error(
                        '401 in CI/non-interactive mode.'
                    );
                    process.exit(1);
                }

                CURRENT_TOKEN = await promptNewToken();

                p--;
                continue;
            }

            console.error(
                `List fetch error on page ${p}:`,
                err.message
            );

            await sleep(5000);

            p--;
            continue;
        }

        // ================= FETCH PROFILES =================

        const batchFile = getBatchFile(p);

        const startIndex = (p === START_PAGE) ? START_USER_INDEX : 0;

        for (let i = startIndex; i < usernames.length; i++) {
            if (isTimeUp()) {
                console.log(
                    '\n⏳ Max runtime reached during profiles.'
                );
                return;
            }

            const username = usernames[i];

            let success = false;
            let retryCount = 0;

            const MAX_RETRIES = 3;

            while (!success) {
                try {
                    console.log(
                        `[Page ${p}] [${i + 1}/${
                            usernames.length
                        }] ${username}`
                    );

                    const profileRes = await axios.get(
                        `${PROFILE_BASE_URL}${username}`,
                        {
                            headers: {
                                authorization: `Bearer ${CURRENT_TOKEN}`
                            }
                        }
                    );

                    const enriched = {
                        _page: p,
                        _username: username,
                        _scraped_at:
                            new Date().toISOString(),
                        ...profileRes.data.data
                    };

                    fs.appendFileSync(
                        batchFile,
                        JSON.stringify(enriched) + '\n'
                    );

                    success = true;

                    await sleep(
                        DELAY_BETWEEN_PROFILES
                    );
                } catch (err) {
                    // ===== TOKEN EXPIRED =====

                    if (err.response?.status === 401) {
                        if (
                            IS_CI ||
                            !IS_INTERACTIVE
                        ) {
                            console.error(
                                '401 in CI/non-interactive mode.'
                            );

                            process.exit(1);
                        }

                        CURRENT_TOKEN =
                            await promptNewToken();

                        continue;
                    }

                    // ===== USER NOT FOUND =====

                    if (err.response?.status === 404) {
                        console.log(
                            `${username} not found (404)`
                        );

                        success = true;
                        continue;
                    }

                    // ===== RETRY LOGIC =====

                    retryCount++;

                    console.log(
                        `Error fetching ${username}: ${err.message}`
                    );

                    if (
                        retryCount >= MAX_RETRIES
                    ) {
                        console.log(
                            `Max retries reached for ${username}`
                        );

                        logFailedUser(username);

                        success = true;
                    } else {
                        console.log(
                            `Retrying in 10s... (${retryCount}/${MAX_RETRIES})`
                        );

                        await sleep(10000);
                    }
                }
            }
        }

        // ================= PAGE COMPLETE =================

        saveCheckpoint(p + 1, 0);

        console.log(
            `✅ Completed page ${p}`
        );
    }
}

// ================= START =================

scrape()
    .then(() => {
        console.log(
            '\n✅ Scraper finished successfully'
        );

        rl.close();

        process.exit(0);
    })
    .catch(err => {
        console.error('\n❌ Fatal Error:\n', err);

        rl.close();

        process.exit(1);
    });