const fs = require("fs");
const path = require("path");
const os = require("os");
const { authorize } = require("./auth/authorize.js");
const fsp = fs.promises;
const { google } = require("googleapis");
const { getDateFromPDF } = require("./pdf_year_getter.js");
const { getDateFromXML } = require("./xml_year_getter.js");
// const monthMapper = {
//   '01': 'januar',
//   '02': 'februar',
//   '03': 'mart',
//   '04': 'april',
//   '05': 'maj',
//   '06': 'jun',
//   '07': 'jul',
//   '08': 'avgust',
//   '09': 'septembar',
//   '10': 'oktobar',
//   '11': 'novembar',
//   '12': 'decembar',
// };
// Map<"TEST/2025/DEVIZNI/pdf", "google-folder-id">
const pathFolderCache = {};

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

/**
 * Get or create a unique Drive folder *by name* without reading from Drive.
 * - Uses only drive.files.create (write operation).
 * - Prevents creating duplicates across runs by using a local cache.
 */
async function getOrCreateSingleFolder(
    drive,
    folderName,
    parentId = undefined
) {
    const cache = loadCache();
    const cacheKey = parentId ? `${parentId}:${folderName}` : folderName;

    // 1. If we already created it in a previous run, just reuse it
    if (cache[cacheKey]) {
        return cache[cacheKey]; // folderId
    }

    // 2. Otherwise create a new folder on Drive
    const fileMetadata = {
        name: folderName,
        mimeType: "application/vnd.google-apps.folder",
        ...(parentId ? { parents: [parentId] } : {}),
    };

    const res = await drive.files.create({
        resource: fileMetadata,
        fields: "id, name",
    });

    const folderId = res.data.id;

    // 3. Store in local cache so we don’t create another one with the same key
    cache[cacheKey] = folderId;
    saveCache(cache);

    return folderId;
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

// Create a folder with given name under given parent
// async function createFolder(drive, parentId, name) {
//   const res = await drive.files.create({
//     requestBody: {
//       name,
//       mimeType: 'application/vnd.google-apps.folder',
//       parents: [parentId],
//     },
//     fields: 'id, name',
//   });

//   console.log(`Created folder: ${name} (id: ${res.data.id})`);
//   return res.data;
// }

async function ensurePath(drive, path) {
    const segments = path
        .split("/")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

    let currentParentId = "root"; // start from My Drive root

    for (const segment of segments) {
        // For simplicity we assume no apostrophes in names (TEST, 2025, FILES, TXT are fine)
        const existing = await findFolderByName(
            drive,
            currentParentId,
            segment
        );
        if (existing) {
            // Folder exists, go inside
            console.log(`Found folder: ${segment} (id: ${existing.id})`);
            currentParentId = existing.id;
        } else {
            // Folder doesn't exist, create it
            const created = await createFolder(drive, currentParentId, segment);
            currentParentId = created.id;
        }
    }

    return currentParentId;
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

async function createNestedFolders(drive, fullPath, parentId = null) {
    const parts = fullPath.split("/").filter(Boolean);
    let currentParent = parentId;

    for (const name of parts) {
        currentParent = await ensureOrCreateFolder(drive, name, currentParent);
    }

    return currentParent; // final folder id
}

async function ensureOrCreateFolder(drive, name, parentId) {
    const escapedName = name.replace(/'/g, "\\'");
    const q = [
        "mimeType = 'application/vnd.google-apps.folder'",
        "trashed = false",
        `name = '${escapedName}'`,
    ];

    if (parentId) {
        q.push(`'${parentId}' in parents`);
    }

    // 1️⃣ Search for folder
    const res = await drive.files.list({
        q: q.join(" and "),
        fields: "files(id, name)",
        spaces: "drive",
        pageSize: 1,
    });

    if (res.data.files?.length > 0) {
        return res.data.files[0].id; // folder already exists
    }

    // 2️⃣ Create folder
    const metadata = {
        name,
        mimeType: "application/vnd.google-apps.folder",
        ...(parentId ? { parents: [parentId] } : {}),
    };

    const newFolder = await drive.files.create({
        resource: metadata,
        fields: "id",
    });

    return newFolder.data.id;
}

async function checkDriveFolderWithName(drive, folderName) {
    const q = [
        "mimeType = 'application/vnd.google-apps.folder'",
        "trashed = false",
        `name = '${folderName.replace(/'/g, "\\'")}'`,
    ].join(" and ");

    const res = await drive.files.list({
        q,
        fields: "files(id, name, parents, driveId)",
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
        corpora: "allDrives", // My Drive + all Shared Drives
    });

    console.log("Query:", q);
    console.log("Found folders:", res.data.files);

    return res.data.files[0] ?? null;
}
async function uploadFile(fileDetails, fullPath, auth) {
    const drive = google.drive({ version: "v3", auth });
    const { fileName, type, date, extension } = fileDetails;
    const TARGET_PATH = `TEST/${date.year}/${type}/${extension}`;

    console.log(`Resolving path: ${TARGET_PATH}`);
    const folderId = await ensureDrivePath(drive, TARGET_PATH);
    console.log(`Final target folder id: ${folderId}`);

    const fileAlreadyExistsInDrive = await driveFileExists(
        drive,
        folderId,
        fileName
    );
    if (fileAlreadyExistsInDrive) {
        console.log(
            `⚠️ File already exists on Drive, skipping upload: ${fileName}`
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

async function debugListSomeFolders(drive) {
    const res = await drive.files.list({
        q: "mimeType = 'application/vnd.google-apps.folder' and trashed = false",
        pageSize: 10,
        fields: "files(id, name)",
        spaces: "drive",
    });

    console.log("Visible folders for this credential:", res.data.files);
}

async function createTestFolder(auth) {
    const drive = google.drive({ version: "v3", auth });

    await drive.files.create({
        requestBody: {
            name: "TEST",
            mimeType: "application/vnd.google-apps.folder",
        },
    });
}

async function moveStoreAndUploadFiles(auth) {
    // Get the downloads folder path based on the OS
    const drive = google.drive({ version: "v3", auth });
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
            extension
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
                    fileName
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

// Create all necessary directories if they don't exist
// function createDirectories() {
//     [dinarskiDir, devizniDir, dinarskiPdfDir, devizniPdfDir].forEach((dir) => {
//         if (!fs.existsSync(dir)) {
//             fs.mkdirSync(dir, { recursive: true });
//             console.log(`Created directory: ${dir}`);
//         }
//     });
// }

// Function to check if file already exists in target directory
function isDuplicate(targetDir, newFileName) {
    return fs.existsSync(path.join(targetDir, newFileName));
}

// Function to delete file
function deleteFile(filePath) {
    try {
        fs.unlinkSync(filePath);
        console.log(`Deleted: ${path.basename(filePath)}`);
    } catch (error) {
        console.error(`Error deleting file ${filePath}:`, error.message);
    }
}

// Function to get new filename based on rules
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

// Function to determine target directory based on file type and extension
// function getTargetDirectory(fileType, extension) {
//     if (fileType === 'dinarski') {
//         return extension === '.pdf' ? dinarskiPdfDir : dinarskiDir;
//     } else {
//         return extension === '.pdf' ? devizniPdfDir : devizniDir;
//     }
// }

// async function organizeFiles(auth) {
//   try {
//     // Check if source directory exists
//     if (!fs.existsSync(sourceDir)) {
//       console.error('Source directory does not exist:', sourceDir);
//       return;
//     }

//     // Create destination directories
//     // createDirectories();

//     // Move all the files from downloads to the sourceDir
//     // moveFilesFromDownloads();

//     // Read all files in the directory
//     const files = fs.readdirSync(sourceDir);

//     if (files.length === 0) {
//       console.log('No files found in directory');
//       return;
//     }

//     // Track statistics
//     const stats = {
//       processed: 0,
//       deleted: 0,
//       skipped: 0,
//       duplicates: 0,
//     };

//     // Build an array of async tasks
//     const tasks = files.map(async (file) => {
//       const oldPath = path.join(sourceDir, file);

//       // Skip if it's a directory
//       if (fs.statSync(oldPath).isDirectory()) return;

//       // Skip if file is not PDF or XML
//       const extension = path.extname(file).toLowerCase();
//       if (extension !== '.pdf' && extension !== '.xml') {
//         deleteFile(oldPath);
//         stats.deleted++;
//         return;
//       }

//       // Get new filename
//       const newFileInfo = getNewFileName(file);

//       if (newFileInfo) {
//         // Determine target directory based on file type and extension
//         const targetDir = getTargetDirectory(newFileInfo.type, extension);

//         // Check for duplicates
//         if (isDuplicate(targetDir, newFileInfo.newName)) {
//           console.log(`Duplicate found, skipping: ${file}`);
//           deleteFile(oldPath);
//           stats.duplicates++;
//           return;
//         }

//         // Move and rename file
//         const newPath = path.join(targetDir, newFileInfo.newName);
//         fs.renameSync(oldPath, newPath);

//         const locationStr = `${newFileInfo.type === 'dinarski' ? 'Dinarski' : 'Devizni'}${
//           extension === '.pdf' ? '/PDF' : ''
//         } folder`;

//         console.log(`Moved and renamed: ${file} -> ${newFileInfo.newName}`);
//         console.log(`Location: ${locationStr}`);

//         if (auth) {
//           await uploadFile(newFileInfo, newPath, auth);
//         }

//         stats.processed++;
//       } else {
//         // Delete files that don't match the "Izvod br." pattern
//         deleteFile(oldPath);
//         stats.deleted++;
//       }
//     });

//     // ✅ Wait for ALL file tasks to finish
//     await Promise.all(tasks);

//     // ✅ Now it's safe to print summary
//     console.log('\nOperation Summary:');
//     //add stats.uploaded
//     console.log(`Files processed: ${stats.processed}`);
//     console.log(`Files deleted: ${stats.deleted}`);
//     console.log(`Duplicates found: ${stats.duplicates}`);
//     console.log(`Total files handled: ${stats.processed + stats.deleted + stats.duplicates}`);

//     console.log('\nDirectory structure:');
//     console.log('Dinarski/');
//     console.log('  ├── PDF/    (PDF files)');
//     console.log('  └── ...     (XML files)');
//     console.log('Devizni/');
//     console.log('  ├── PDF/    (PDF files)');
//     console.log('  └── ...     (XML files)');
//   } catch (error) {
//     console.error('Error:', error.message);
//   }
// }

// Run the script
authorize()
    .then(async (auth) => {
        await moveStoreAndUploadFiles(auth);
    })
    .catch((error) => console.error(error.message));
