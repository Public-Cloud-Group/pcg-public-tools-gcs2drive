# Public Cloud Group - GCS 2 Drive Transfer Tool
This application is designed to transfer big up to 50 GB files from a **Google Cloud Storage Bucket** to **Google Drive** using Byte-Ranges and [Google Drive Resumable Uploads](https://developers.google.com/drive/api/guides/manage-uploads#resumable).

## Cloud-Native
This applcation is designed to run cloud-natively on **Google Cloud Functions**. It can be used to transfer files up to a size of 7GB (1. Generation Cloud Function) or 60GB (2. Generation). Nevertheless, this NodeJS Code can be runned on any other runtime as well.

## Documention
This script was published as part of a Blogpost of [PCG's insights](https://pcg.io/de/insights/?type=articles) series. The [Blogpost "_Große Dateien von Google Cloud Storage zu Google Drive übertragen_"](https://pcg.io/de/insights/grosse-dateien-von-google-cloud-storage-zu-google-drive-uebertragen/) holds additional (German) documentation and experiences.

### Setup
Run `npm install` to install dependencies.

#### Authentication
This tool can use the build-int Service Account of Cloud Function to authenticate agains GCS and Google Drive. A separate `secret.json` file can be provided to use a dedicated service account or to use it locally. 

Set the `SECRET_JSON` variable to `null` to use the internal Service Account or set `SECRET_JSON` to point to your secrets file.

The service account user must have `storage.objects.get` (copy) and `storage.objects.delete` (move only) permissions on the bucket and the "Contributor" Role on the Drive Folder.

#### Other variables
The following variables can be injected using environment variables
* `DRIVEFOLDER`: target folder in Google Drive
* `CHUNK_SIZE`: size of a chunk per loop (multiple of 256Kb)

#### Ownership & Google Workspace
The owner of the uploaded files will be the Service Account, even if the folder belongs to another user. The service account's Google Drive has only 15 GB of space and will be deleted if the Service Account deleted.

If you are a user of a Google Workspace domain, we strongly recommend to transfer the files to a [Shared Drive](https://pcg.io/de/insights/meine-ablage-vs-geteilte-ablagen-in-google-drive/) because then the organization is the owner eventually.

### Run
This function is designed to run in Google Cloud's Cloud Function. To run the application locally, the *functions-framework* is integrated and the function can be called over an HTTP call. 

Run `npm start` to start the server.

### Transfer-Call
```
GET /gcs2drive
```

Call the service using the parameters
* `bucket`: name of the bucket
* `filename`: path and file name to the file in the GCS bucket

_Example: http://localhost:8080/gcs2drive?bucket=my-bucket-name&filename=folder1/subfolder/file.zip_

### Performance & Recommended settings
The transfer rate is about 1 GB of file per Minute (1GB download + 1 GB upload) if the files are processed within the same (multi-)region.

The chunk size **must** be a mulitple of 256kb. We recommend a chunk size of `524288000` (500MB) and a Cloud Function Memory Size of `4` GB.

Scaling up the Cloud Function runtime resources in 2nd Generation does not have a significant impact on the transfer rate.

## Licence
This script is published under [MIT Licence](/LICENCE).