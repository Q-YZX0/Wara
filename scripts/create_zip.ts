
import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';

// --- CONFIGURATION ---
const ROOT_DIR = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT_DIR, 'releases');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'update.zip');

const INCLUDED_DIRS = ['src', 'prisma', 'config']; // Include potential other needed dirs
const INCLUDED_FILES = ['package.json', 'tsconfig.json'];

async function createUpdateZip() {
    console.log("=========================================");
    console.log("   WARA NODE - CREATE UPDATE ZIP         ");
    console.log("=========================================");

    // 1. Prepare Output Directory
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    // Remove old zip if exists
    if (fs.existsSync(OUTPUT_FILE)) {
        fs.unlinkSync(OUTPUT_FILE);
        console.log("🗑️  Removed old update.zip");
    }

    const zip = new AdmZip();

    // 2. Add Directories
    console.log("📂 Adding directories...");
    for (const dirName of INCLUDED_DIRS) {
        const fullPath = path.join(ROOT_DIR, dirName);
        if (fs.existsSync(fullPath)) {
            console.log(`   + ${dirName}`);
            // We add the folder content to the root of zip or preserving path?
            // update_node.ts expects 'src' to be inside the zip so it can extract it.
            // AdmZip.addLocalFolder adds content of folder to zip root by default unless zipPath is given.
            // We want the folder itself to be in the zip.
            zip.addLocalFolder(fullPath, dirName);
        } else {
            console.warn(`⚠️  Directory not found: ${dirName}`);
        }
    }

    // 3. Add Files
    console.log("📄 Adding files...");
    for (const fileName of INCLUDED_FILES) {
        const fullPath = path.join(ROOT_DIR, fileName);
        if (fs.existsSync(fullPath)) {
            console.log(`   + ${fileName}`);
            zip.addLocalFile(fullPath);
        } else {
            console.warn(`⚠️  File not found: ${fileName}`);
        }
    }

    // 4. Write Zip
    try {
        console.log(`💾 Writing zip to: ${OUTPUT_FILE}`);
        zip.writeZip(OUTPUT_FILE);
        console.log("✅ Update package created successfully!");
        console.log(`   Size: ${(fs.statSync(OUTPUT_FILE).size / 1024 / 1024).toFixed(2)} MB`);
    } catch (e: any) {
        console.error(`❌ Failed to write zip: ${e.message}`);
        process.exit(1);
    }
}

createUpdateZip();
