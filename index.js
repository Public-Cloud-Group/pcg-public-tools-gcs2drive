const os = require('os');
const fse = require('fs-extra')
const { google } = require('googleapis');
const { GoogleAuth } = require('google-auth-library');
const { Storage } = require('@google-cloud/storage');

const DRIVEFOLDER = process.env.DRIVEFOLDER || '1FKM7-wkh80DiYv9fk7DfEFBC6KEL5NhV'; // Teamd Drive Folder
const CHUNK_SIZE = process.env.CHUNK_SIZE || 1024 * 256 * 200; // MUST be multiple of 256kb
const SCOPES = ['https://www.googleapis.com/auth/drive'];
const SECRET_FILE = 'secret.json'; // set to null for CF (built-in service account)
const MOVE = false; // move instead of copy

let storage, client;

/**
 * function entrypoint
 * 
 * @param {*} req 
 * @param {*} res 
 * @returns 
 */
exports.gcs2drive = async (req, res) => {
    let bucket = req.body.bucket || req.query.bucket;
    let fileName = req.body.filename || req.query.filename;

    if (!bucket) {
        res.status(500).send("Bucket is missing");
        return;
    }

    if (!fileName) {
        res.status(500).send("File name is missing");
        return;
    }

    let object_metadata = await gcs_get_object_metadata(bucket, fileName);
    let sourceSize = parseInt(object_metadata.size);
    let md5Hash = Buffer.from(object_metadata.md5Hash, 'base64').toString("hex");
    console.log("File size is", (sourceSize / 1000000).toFixed(2), 'MB');

    let loops = Math.ceil(sourceSize / CHUNK_SIZE);

    console.log("Transfer in", loops, "chunks");

    var startByte = 0;
    var endByte = 0;
    var totalByeUpload = sourceSize;
    var lastLoop = false;
    var result = null;

    await drive_client();
    let resumableUrl = await drive_upload_resumable_init(fileName, DRIVEFOLDER, totalByeUpload);

    for (var i = 0; i < loops; i++) {
        if (i == (loops - 1)) {
            lastLoop = true;
            console.log("Process last chunk", i + 1, "/", loops);
        } else {
            console.log("Process chunk", i + 1, "/", loops);
        }
        var targetFile = os.tmpdir() + '/' + fileName.split('/').pop() + '_' + i;

        startByte = i * CHUNK_SIZE;
        endByte = Math.min(startByte + CHUNK_SIZE - 1, sourceSize - 1);
        console.log("Download bytes", startByte, "->", endByte, "into", targetFile);
        await gcs_download_file(bucket, fileName, targetFile, startByte, endByte);

        var tempSize = fse.statSync(targetFile).size;
        console.log("Download temp file size is", tempSize);

        result = await drive_upload_resumable(resumableUrl, targetFile, totalByeUpload, startByte, endByte);

        // delete temp file to keep memory size low
        await local_delete(targetFile);
    }

    if (result.id) {
        console.log("Created file", result.id);
    }

    // do integrity checking
    let drive_metadata = await drive_get_metadata(result.id);
    let verified = false;
    let status = "transferred";

    if (md5Hash == drive_metadata['md5Checksum']) {
        console.info("Verified: Checksums match");
        verified = true;
    } else {
        console.error("Not verified: Checksums do not match", md5Hash, " <> ", drive_metadata['md5Checksum']);
        status = "checksum_mismatch";
    }

    if (MOVE && verified) {
        await gcs_delete(bucket, fileName);
        console.log("Deleted file", fileName, "from bucket", bucket);
    }

    var response = { 'status': status, 'drive_id': result.id };

    console.log("Send response", response);
    res.send(response);
};

/**
 * intitialize client for Drive REST API
 */
async function drive_client() {
    let authConfig = { scopes: SCOPES };

    // secret file is configured
    if (SECRET_FILE) {
        authConfig['keyFile'] = SECRET_FILE;
    }

    let auth = new GoogleAuth(authConfig);
    client = await auth.getClient();
}

/**
 * start a resumable upload
 * 
 * @param {*} fileName 
 * @param {*} folderId 
 * @param {*} totalSize 
 * @returns 
 */
async function drive_upload_resumable_init(fileName, folderId, totalSize) {
    let result = await client.request(
        {
            method: "POST",
            url:
                "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true",
            headers: {
                "Content-Type": "application/json",
                "X-Upload-Content-Length": totalSize
            },
            body: JSON.stringify({
                name: fileName, parents: [folderId],
                supportsTeamDrives: true,
            })
        });

    return result.headers.location;
}

/**
 * continue a resumable upload
 * 
 * @param {*} url 
 * @param {*} sourceFile 
 * @param {*} size 
 * @param {*} startByte 
 * @param {*} endByte 
 * @returns 
 */
async function drive_upload_resumable(url, sourceFile, size, startByte, endByte) {
    var result = null;

    try {
        result = await client.request(
            {
                method: "PUT",
                url: url,
                headers: { "Content-Range": `bytes ${startByte}-${endByte}/${size}` },
                body: fse.readFileSync(sourceFile)
            }
        )
    } catch (e) {
        if (e.response && e.response.status == 308) {
            console.log("Status:", e.response.status, e.response.statusText);
            return e.response;
        } else {
            console.error("Catched error", e);
        }
    }
    console.log("Status:", result.status, result.statusText);
    return result.data;
}

/**
 * get metadata of drive file
 * 
 * @param {*} fileId 
 * @returns 
 */
async function drive_get_metadata(fileId) {
    let fields = ['md5Checksum', 'sha1Checksum', 'sha256Checksum'];
    let url = `https://www.googleapis.com/drive/v3/files/${fileId}?supportsAllDrives=true&fields=${fields.join('%2C')}`;

    try {
        result = await client.request(
            {
                method: "GET",
                url: url
            }
        )
    } catch (e) {
        console.error("Catched error", e);

    }

    return result.data;
}

/**
 * initialize Google Cloud Storage client
 */
async function gcs_init_client() {
    let clientConfig = {};
    if (SECRET_FILE) {
        clientConfig['keyFilename'] = SECRET_FILE;
    }

    storage = new Storage(clientConfig);
}

/**
 * get gcs object metadata
 * 
 * @param {*} bucketName 
 * @param {*} fileName 
 * @returns 
 */
async function gcs_get_object_metadata(bucketName, fileName) {
    await gcs_init_client();

    let metadata = (await storage.bucket(bucketName).file(fileName).getMetadata())[0];

    return metadata;
}

/**
 * download byte-range of a GCS object
 * 
 * @param {*} bucketName 
 * @param {*} fileName 
 * @param {*} targetFile 
 * @param {*} startByte 
 * @param {*} endByte 
 * @returns 
 */
async function gcs_download_file(bucketName, fileName, targetFile, startByte, endByte) {
    await gcs_init_client();

    async function downloadFile() {
        const options = {
            destination: targetFile,
            start: startByte,
            end: endByte,
        };

        // Downloads the file
        let content = await storage.bucket(bucketName).file(fileName).download(options);

        console.log(
            `gs://${bucketName}/${fileName} downloaded to ${targetFile}.`
        );

        return content;
    }

    var destFileName = await downloadFile().catch(console.error);
    return destFileName;
}

/**
 * delete a GCS object
 * 
 * @param {*} bucketName 
 * @param {*} fileName 
 * @returns 
 */
async function gcs_delete(bucketName, fileName) {
    const { Storage } = require('@google-cloud/storage');
    const storage = new Storage();

    async function deleteFile() {

        // Downloads the file
        await storage.bucket(bucketName).file(fileName).delete();

        console.log(
            `gs://${bucketName}/${fileName} deleted.`
        );

        return true;
    }

    var result = await deleteFile().catch(console.error);
    return result;
}

/**
 * delete a local file
 * 
 * @param {*} destFileName 
 */
async function local_delete(destFileName) {
    fse.removeSync(destFileName);
    console.log("Removed temp file", destFileName);
}
