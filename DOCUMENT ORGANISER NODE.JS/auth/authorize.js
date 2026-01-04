const fs = require("fs");
const readline = require("readline");
const { google } = require("googleapis");

const SCOPES = ["https://www.googleapis.com/auth/drive"];
const TOKEN_PATH = "./auth/token.json";

function loadCredentials() {
    const content = fs.readFileSync("./auth/credentials.json", "utf8");
    return JSON.parse(content);
}

function getOAuth2Client() {
    const credentials = loadCredentials();
    const { client_secret, client_id, redirect_uris } = credentials.installed;
    return new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
}

function getNewToken(oAuth2Client) {
    return new Promise((resolve, reject) => {
        const authUrl = oAuth2Client.generateAuthUrl({
            access_type: "offline",
            prompt: "consent",
            scope: SCOPES,
        });
        console.log("Authorize this app by visiting this URL:\n", authUrl);

        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });

        rl.question("\nEnter the code from that page here: ", async (code) => {
            rl.close();
            try {
                const { tokens } = await oAuth2Client.getToken(code.trim());
                oAuth2Client.setCredentials(tokens);
                fs.writeFileSync(
                    TOKEN_PATH,
                    JSON.stringify(tokens, null, 2),
                    "utf8"
                );
                console.log("Token stored to", TOKEN_PATH);
                resolve(oAuth2Client);
            } catch (err) {
                console.error("Error exchanging code for token:", err);
                reject(err);
            }
        });
    });
}

async function authorize() {
    const oAuth2Client = getOAuth2Client();

    if (fs.existsSync(TOKEN_PATH)) {
        const token = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
        oAuth2Client.setCredentials(token);
        return oAuth2Client;
    }

    return await getNewToken(oAuth2Client);
}

module.exports = {
    authorize,
};
