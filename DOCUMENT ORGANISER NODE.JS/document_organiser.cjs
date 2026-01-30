const fs = require("fs");
const path = require("path");
const os = require("os");
const { authorize } = require("./auth/authorize.js");
const fsp = fs.promises;
const { google } = require("googleapis");
const { getDateFromPDF } = require("./pdf_year_getter.js");
const { getDateFromXML } = require("./xml_year_getter.js");

// Load cache from disk (path -> folderId)
function loadCache() {
    const CACHE_PATH = path.join(__dirname, "folder_cache.json");
    if (!fs.existsSync(CACHE_PATH)) return {};
    try {
        return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    } catch {
        return {};
    }
}

// Save cache to disk
function saveCache(cache) {
    const CACHE_PATH = path.join(__dirname, "folder_cache.json");
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), "utf8");
}

let memoryFolderCache = loadCache();
const pendingFolderCreates = new Map();

function getCache() {
    return memoryFolderCache;
}

function updateCache(updates) {
    memoryFolderCache = { ...memoryFolderCache, ...updates };
    saveCache(memoryFolderCache);
}

function deleteCacheKey(key) {
    if (memoryFolderCache[key]) {
        delete memoryFolderCache[key];
        saveCache(memoryFolderCache);
    }
}

async function seedRootFolderCache(drive, rootName) {
    const cache = getCache();
    const cacheKey = `root:${rootName}`;
    if (cache[cacheKey]) return;

    const res = await drive.files.list({
        q: [
            "mimeType = 'application/vnd.google-apps.folder'",
            "trashed = false",
            `name = '${rootName.replace(/'/g, "\\'")}'`,
        ].join(" and "),
        fields: "files(id, name, parents, driveId)",
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
        corpora: "allDrives",
        pageSize: 5,
    });

    const files = res.data.files || [];
    if (files.length > 0) {
        updateCache({ [cacheKey]: files[0].id });
        if (files.length > 1) {
            console.log(
                `Found ${files.length} folders named ${rootName}; using ${files[0].id}`,
            );
        }
    }
}

async function cleanFolderCache(drive) {
    const cache = getCache();
    let changed = false;

    for (const [key, folderId] of Object.entries(cache)) {
        try {
            const meta = await drive.files.get({
                fileId: folderId,
                fields: "id, trashed",
                supportsAllDrives: true,
            });
            if (meta.data.trashed) {
                delete cache[key];
                changed = true;
            }
        } catch {
            delete cache[key];
            changed = true;
        }
    }

    if (changed) {
        memoryFolderCache = cache;
        saveCache(cache);
        console.log("Cleaned folder cache (removed trashed/missing ids).");
    }
}

/**
 * Get or create a unique Drive folder *by name* without reading from Drive.
 * - Uses only drive.files.create (write operation).
 * - Prevents creating duplicates across runs by using a local cache.
 */
async function getOrCreateSingleFolder(
    drive,
    folderName,
    parentId = undefined,
) {
    const cache = getCache();
    const effectiveParentId = parentId ?? "root";
    const cacheKey = `${effectiveParentId}:${folderName}`;

    // 1. If we already created it in a previous run, just reuse it
    if (cache[cacheKey]) {
        try {
            const cachedId = cache[cacheKey];
            const meta = await drive.files.get({
                fileId: cachedId,
                fields: "id, name, trashed",
                supportsAllDrives: true,
            });
            if (!meta.data.trashed) {
                return cachedId; // folderId
            }
            // Cached folder is trashed, drop cache and continue
            deleteCacheKey(cacheKey);
        } catch {
            // Cached folder missing or inaccessible, drop cache and continue
            deleteCacheKey(cacheKey);
        }
    }

    if (pendingFolderCreates.has(cacheKey)) {
        return pendingFolderCreates.get(cacheKey);
    }

    const createPromise = (async () => {
        // 2. Check Drive for an existing folder under the parent
        const existing = await findFolderByName(
            drive,
            effectiveParentId,
            folderName,
        );
        if (existing) {
            updateCache({ [cacheKey]: existing.id });
            return existing.id;
        }

        // 3. Otherwise create a new folder on Drive
        const fileMetadata = {
            name: folderName,
            mimeType: "application/vnd.google-apps.folder",
            parents: [effectiveParentId],
        };

        const res = await drive.files.create({
            resource: fileMetadata,
            fields: "id, name",
        });

        const folderId = res.data.id;

        // 4. Store in local cache so we don't create another one with the same key
        updateCache({ [cacheKey]: folderId });

        return folderId;
    })();

    pendingFolderCreates.set(cacheKey, createPromise);
    try {
        return await createPromise;
    } finally {
        pendingFolderCreates.delete(cacheKey);
    }
}

async function ensureDrivePath(drive, targetPath) {
    const parts = targetPath
        .split("/")
        .map((p) => p.trim())
        .filter(Boolean);

    let parentId = "root";

    for (const folderName of parts) {
        parentId = await getOrCreateSingleFolder(drive, folderName, parentId);
    }

    return parentId; // final folderId
}

// Find a folder with given name under a given parent, or return null
async function findFolderByName(drive, parentId, name) {
    const res = await drive.files.list({
        q: [
            "mimeType = 'application/vnd.google-apps.folder'",
            "trashed = false",
            `'${parentId}' in parents`,
            `name = '${name}'`,
        ].join(" and "),
        fields: "files(id, name)",
        spaces: "drive",
    });

    const files = res.data.files || [];
    return files[0] || null; // if multiple, just take first
}

async function driveFileExists(drive, folderId, fileName) {
    const res = await drive.files.list({
        q: [
            `'${folderId}' in parents`,
            `name = '${fileName}'`,
            "trashed = false",
        ].join(" and "),
        fields: "files(id, name)",
        spaces: "drive",
        pageSize: 1,
    });

    const files = res.data.files || [];
    return files.length > 0;
}
async function uploadFile(fileDetails, fullPath, auth) {
    const drive = google.drive({ version: "v3", auth });
    const { fileName, type, date, extension } = fileDetails;
    const TARGET_PATH = `TEST/${date.year}/${type.toUpperCase()}/${extension.toUpperCase()}`;

    console.log(`Resolving path: ${TARGET_PATH}`);
    const folderId = await ensureDrivePath(drive, TARGET_PATH);
    console.log(`Final target folder id: ${folderId}`);

    const fileAlreadyExistsInDrive = await driveFileExists(
        drive,
        folderId,
        fileName,
    );
    if (fileAlreadyExistsInDrive) {
        console.log(
            `⚠️ File already exists on Drive, skipping upload: ${fileName}`,
        );
        return;
    }

    // Map extension -> correct MIME type
    const mimeType =
        extension.toLowerCase() === "pdf"
            ? "application/pdf"
            : "application/xml";

    try {
        const res = await drive.files.create({
            requestBody: {
                name: fileName,
                parents: [folderId],
            },
            media: {
                mimeType,
                body: fs.createReadStream(fullPath),
            },
            fields: "id, name, webViewLink",
        });
        console.log(`Uploaded: ${fileName}`, res.data);
    } catch (err) {
        console.error(`Failed to upload ${fileName}:`, err.message);
    }
}

// Directory paths
const sourceDir = "C:/PERSONAL/4SOLUTIONS IZVODI";

async function moveStoreAndUploadFiles(auth) {
    // Get the downloads folder path based on the OS
    const drive = google.drive({ version: "v3", auth });
    await cleanFolderCache(drive);
    await seedRootFolderCache(drive, "TEST");
    const downloadsDir = path.join(os.homedir(), "Downloads");
    // Ensure destination directory exists
    if (!fs.existsSync(sourceDir)) {
        fs.mkdirSync(sourceDir, { recursive: true });
        console.log(`Created destination directory: ${sourceDir}`);
    }

    // Read the downloads directory
    const files = fs.readdirSync(downloadsDir);

    if (files.length === 0) {
        console.log("No files found in downloads directory");
        return;
    }

    let moveCount = 0;

    // Move each file
    const movedFiles = files.map(async (file) => {
        const sourcePath = path.join(downloadsDir, file);
        const fileDoesNotMatch = !file.match(/Izvod br\. \d+/);
        if (fileDoesNotMatch) return;
        const fileDetails = await getNewFileDetails(file, sourcePath);
        const { fileName, extension, type, date } = fileDetails;
        const destinationDirectory = path.join(
            sourceDir,
            date.year,
            type.toUpperCase(),
            extension,
        );

        if (!fs.existsSync(destinationDirectory)) {
            fs.mkdirSync(destinationDirectory, { recursive: true });
        }

        // Check if it's a file (not a directory)
        const stats = fs.statSync(sourcePath);
        if (stats.isFile()) {
            try {
                const destinationPath = path.join(
                    destinationDirectory,
                    fileName,
                );

                // Copy the file to destination then delete the original
                if (auth) {
                    await uploadFile(fileDetails, sourcePath, auth).then(() => {
                        fs.copyFileSync(sourcePath, destinationPath);
                        fs.unlinkSync(sourcePath); // Delete the original file
                        console.log(`Moved: ${fileName}`);
                        moveCount++;
                    });
                }
            } catch (err) {
                console.error(`Error moving ${fileName}: ${err.message}`);
            }
        }
    });

    // ✅ Wait for ALL file tasks to finish
    await Promise.all(movedFiles);
    console.log(`Operation completed. ${moveCount} files moved successfully!`);
}

async function getNewFileDetails(oldFileName, sourcePath) {
    // Extract the "Izvod br. X" part using regex
    const match = oldFileName.match(/Izvod br\. \d+/);
    if (!match) return null;

    const izvodPart = match[0];
    const extension = path.extname(oldFileName);
    const type = oldFileName.includes("-Realizovani") ? "dinarski" : "devizni";
    // const typeCapitalised = type[0].toUpperCase() + type.slice(1);

    let date = null;
    if (extension.toLowerCase() === ".pdf")
        date = await getDateFromPDF(sourcePath, type);
    if (extension.toLowerCase() === ".xml")
        date = await getDateFromXML(sourcePath);

    return {
        fileName: `${izvodPart} (${type}) (${date.day}.${date.month}.${date.year}) - 4SOLUTIONS${extension}`,
        type,
        extension: extension.slice(1),
        date,
    };
}

// Run the script
authorize()
    .then(async (auth) => {
        await moveStoreAndUploadFiles(auth);
    })
    .catch((error) => console.error(error.message));
