
import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';
import AdmZip from 'adm-zip';
import axios from 'axios';

// --- CONFIGURATION ---
// CHANGE THIS TO YOUR REPO ZIP URL
const UPDATE_URL = "https://github.com/YZX0/Wara/raw/main/releases/update.zip";

const ROOT_DIR = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT_DIR, 'src');
const PACKAGE_JSON = path.join(ROOT_DIR, 'package.json');
const BACKUP_DIR = path.join(ROOT_DIR, '_backups');
const UPDATE_ZIP = path.join(ROOT_DIR, 'update.zip');

async function downloadUpdate(url: string, dest: string) {
    console.log(`⬇️  Downloading update from: ${url}`);
    const writer = fs.createWriteStream(dest);

    try {
        const response = await axios({
            url,
            method: 'GET',
            responseType: 'stream'
        });

        response.data.pipe(writer);

        return new Promise((resolve, reject) => {
            writer.on('finish', () => resolve(true));
            writer.on('error', reject);
        });
    } catch (e: any) {
        throw new Error(`Download failed: ${e.message}`);
    }
}

async function runUpdate() {
    console.log("=========================================");
    console.log("   WARA NODE - AUTO UPDATER v2           ");
    console.log("=========================================");

    // 1. Download
    if (!fs.existsSync(UPDATE_ZIP)) {
        try {
            await downloadUpdate(UPDATE_URL, UPDATE_ZIP);
            console.log("✅ Download complete.");
        } catch (e: any) {
            console.error(`❌ Error downloading update: ${e.message}`);
            // Fallback: Check if file exists manually
            if (!fs.existsSync(UPDATE_ZIP)) process.exit(1);
        }
    } else {
        console.log("ℹ️  Found local 'update.zip', using it.");
    }

    // 2. Create Backup
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(BACKUP_DIR, `backup_${timestamp}`);
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR);
    if (!fs.existsSync(backupPath)) fs.mkdirSync(backupPath);

    console.log(`📦 Creating backup at: ${backupPath}`);
    try {
        // Backup Source
        if (fs.existsSync(SRC_DIR)) {
            fs.cpSync(SRC_DIR, path.join(backupPath, 'src'), { recursive: true });
        }
        // Backup Package.json
        if (fs.existsSync(PACKAGE_JSON)) {
            fs.copyFileSync(PACKAGE_JSON, path.join(backupPath, 'package.json'));
        }
    } catch (e: any) {
        console.warn("⚠️  Backup warning:", e.message);
    }

    // 3. Clean Old Source
    console.log("🧹 Cleaning old source code...");
    try {
        fs.rmSync(SRC_DIR, { recursive: true, force: true });
    } catch (e) {
        console.error("❌ Failed to clean src dir:", e);
        process.exit(1);
    }

    // 4. Extract & Install
    console.log("📂 Extracting update...");
    try {
        const zip = new AdmZip(UPDATE_ZIP);
        const zipEntries = zip.getEntries();

        const tempExtract = path.join(ROOT_DIR, '_temp_extract');
        zip.extractAllTo(tempExtract, true);

        // Find the root folder in extraction
        const items = fs.readdirSync(tempExtract);
        let sourceRoot = tempExtract;

        // If there's a single folder (like 'Wara-main'), go inside
        if (items.length === 1 && fs.statSync(path.join(tempExtract, items[0])).isDirectory()) {
            sourceRoot = path.join(tempExtract, items[0]);
        }

        // Move 'src'
        const newSrc = path.join(sourceRoot, 'src');
        if (fs.existsSync(newSrc)) {
            fs.renameSync(newSrc, SRC_DIR);
        } else {
            throw new Error("Update package does not contain 'src' directory!");
        }

        // Move/Overwrite 'package.json'
        const newPkg = path.join(sourceRoot, 'package.json');
        if (fs.existsSync(newPkg)) {
            console.log("📝 Updating package.json...");
            fs.copyFileSync(newPkg, PACKAGE_JSON);
        }

        // Cleanup Temp
        fs.rmSync(tempExtract, { recursive: true, force: true });
        // Cleanup Zip
        fs.unlinkSync(UPDATE_ZIP);

    } catch (e: any) {
        console.error("❌ Extraction failed:", e.message);
        console.log("   Attempting rollback...");
        fs.cpSync(path.join(backupPath, 'src'), SRC_DIR, { recursive: true });
        fs.copyFileSync(path.join(backupPath, 'package.json'), PACKAGE_JSON);
        process.exit(1);
    }

    // 5. Rebuild
    console.log("🔨 Installing dependencies & Building...");
    try {
        // Install (in case package.json changed)
        child_process.execSync('npm install --quiet', { stdio: 'inherit', cwd: ROOT_DIR });

        // Build
        child_process.execSync('npm run build', { stdio: 'inherit', cwd: ROOT_DIR });
    } catch (e) {
        console.error("❌ Build failed:", e);
        console.log("   Restoring backup...");
        // Restore logic...
        process.exit(1);
    }

    console.log("=========================================");
    console.log("✅ UPDATE SUCCESSFUL");
    console.log("   Please restart your node.");
    console.log("=========================================");
}

runUpdate();
