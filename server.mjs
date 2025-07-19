// =====================
// Imports
// =====================
// WebSocketServer for real-time client connections
import { WebSocketServer } from 'ws';
// uuid for generating unique upload keys
import { v4 as uuid } from 'uuid';
// AWS S3 client and related multipart upload commands
import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  PutObjectCommand
} from '@aws-sdk/client-s3';

// =====================
// Configuration Constants
// =====================
// AWS region where S3 bucket resides
const REGION = 'us-east-2';
// Name of the S3 bucket to upload video chunks
const BUCKET = 'vibhav-live-video';
// Port on which WebSocket server listens
const PORT = 8080;

// Minimum part size enforced by S3 for multipart uploads (5 MB)
const MIN_PART_SIZE = 5 * 1024 * 1024;
// Target chunk aggregation threshold before flushing to S3 (6 MB)      
const TARGET_PART_SIZE = 6 * 1024 * 1024;  

// Instantiate S3 client with specified region
const s3 = new S3Client({ region: REGION });

// =====================
// WebSocket Server Setup
// =====================
const wss = new WebSocketServer({ port: PORT });
console.log(`Server listening ws://localhost:${PORT}`);

// On each client connection, set up handlers and session state
wss.on('connection', ws => {
  console.log('⚡ WebSocket client connected');

  // Session state variables
  let session = null;                 // Holds { key, uploadId, parts: [] } once multipart starts     
  let partNumber = 0;                 // Counter for uploaded parts
  let closed = false;                 // Flag to ignore further messages after close

  // Buffers for aggregating incoming binary data
  let aggBuffers = [];                // Array of Buffer chunks
  let aggBytes = 0;                   // Total bytes in aggBuffers
  let totalReceivedBytes = 0;         // Cumulative bytes received overall
  // Flag to indicate whether multipart upload has been initiated
  let usingMultipart = false;
  // S3 object key for current upload session    
  let key = null;

  // Helper: send JSON control messages back to client if socket open
  const sendJSON = obj => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  };

  // =====================
  // Initiate Multipart Upload on S3
  // =====================
  const startMultipart = async () => {
    // Avoid starting twice
    if (usingMultipart) return;
    console.log('[MULTIPART STARTING]');
    // Create multipart upload and get uploadId
    const res = await s3.send(new CreateMultipartUploadCommand({
      Bucket: BUCKET,
      Key: key,
      ContentType: 'video/webm'
    }));
    // Save session info for subsequent UploadPart calls
    session = { key, uploadId: res.UploadId, parts: [] };
    usingMultipart = true;
    console.log('[MULTIPART STARTED]', session.uploadId);
    // Notify client that upload session is ready
    sendJSON({ type: 'uploadInfo', key: session.key, uploadId: session.uploadId });
  };

  // =====================
  // Flush Aggregated Buffers as a Multipart Part
  // =====================
  const flushPart = async (isFinal = false) => {
    // If no active session, bail out
    if (!usingMultipart || !session) return;
    if (aggBytes === 0) return;

    // Only start/end a part when you have enough bytes
    if (!isFinal && aggBytes < MIN_PART_SIZE) return;

    partNumber += 1;
    const body = Buffer.concat(aggBuffers, aggBytes);
    aggBuffers = []; aggBytes = 0;

    console.log(`[UPLOAD PART #${partNumber}] size=${body.length}`);
    const uploadPartRes = await s3.send(new UploadPartCommand({
      Bucket: BUCKET,
      Key: session.key,
      UploadId: session.uploadId,
      PartNumber: partNumber,
      Body: body,
    }));

    // Record the real part number + ETag
    session.parts.push({
      PartNumber: partNumber,
      ETag: uploadPartRes.ETag,
    });

    sendJSON({
      type: 'partAck',
      partNumber,
      size: body.length,
      etag: uploadPartRes.ETag,
    });
  };

  // =====================
  // Complete Upload (Single PUT or Multipart Complete)
  // =====================
  const completeUpload = async () => {
    if (!usingMultipart) {
      // Single‐PUT path
      const singleBody = Buffer.concat(aggBuffers, aggBytes);
      console.log('[SINGLE PUT] size=', singleBody.length);
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: singleBody,
        ContentType: 'video/webm',
      }));
      sendJSON({ type: 'completed', location: `s3://${BUCKET}/${key}`, key });
      return;
    }

    // Flush any remaining bytes (even if < MIN_PART_SIZE)
    await flushPart(true);
    console.log('[COMPLETE MULTIPART]', session.uploadId, 'parts=', session.parts);

    // **Sort** your real parts by their PartNumber
    session.parts.sort((a, b) => a.PartNumber - b.PartNumber);

    console.log('→ sending CompleteMultipartUpload with parts:', session.parts);
    const completeRes = await s3.send(new CompleteMultipartUploadCommand({
      Bucket: BUCKET,
      Key: session.key,
      UploadId: session.uploadId,
      MultipartUpload: { Parts: session.parts },
    }));

    sendJSON({
      type: 'completed',
      location: completeRes.Location,
      key: session.key,
    });
  };

  // =====================
  // Handle Incoming WebSocket Messages
  // =====================
  ws.on('message', async (data, isBinary) => {
    // Ignore if connection already closed
    if (closed) return;

    try {
      // Control frames (text JSON)
      if (!isBinary) {
        let msg;
        try { msg = JSON.parse(data.toString()); }
        catch {
          sendJSON({ type: 'error', message: 'Invalid JSON control message' });
          return;
        }

        if (msg.type === 'start') {
          // Prevent duplicate starts
          if (key) {
            sendJSON({ type: 'error', message: 'Upload already in progress' });
            return;
          }
          // Generate unique S3 key and defer actual multipart start until enough data
          key = `recordings/${Date.now()}-${uuid()}.webm`;
          console.log('[START] key=', key);
          // Placeholder info to let client proceed to READY state
          sendJSON({ type: 'uploadInfo', key, uploadId: null, deferred: true });
        }

        if (msg.type === 'stop') {
          // Finalize upload on stop
          if (!key) {
            sendJSON({ type: 'error', message: 'No active session to stop' });
            return;
          }
          try {
            await completeUpload();
          } catch (e) {
            console.error('Complete failed', e);
            sendJSON({ type: 'error', message: 'Complete multipart failed' });
          } finally {
            // Reset session state for future uploads
            session = null;
            key = null;
            partNumber = 0;
            aggBuffers = [];
            aggBytes = 0;
            usingMultipart = false;
          }
        }
        return;
      }

      // Binary data frame: accumulate for multipart or single PUT
      if (!key) {
        sendJSON({ type: 'error', message: 'No active session' });
        return;
      }

      // Buffer the binary chunk
      aggBuffers.push(data);
      aggBytes += data.length;
      totalReceivedBytes += data.length;

      // If threshold crossed, kick off multipart upload
      if (!usingMultipart && aggBytes >= MIN_PART_SIZE) {
        await startMultipart();
      }

      // In multipart mode, flush whenever buffer grows beyond target
      if (usingMultipart && aggBytes >= TARGET_PART_SIZE) {
        await flushPart(false);
      }

    } catch (err) {
      console.error('Generic upload error', err);
      sendJSON({ type: 'error', message: err.message || 'Upload error' });
    }
  });

  // =====================
  // Handle WebSocket Close
  // =====================
  ws.on('close', async () => {
    closed = true;
    // Abort in-progress multipart on abrupt disconnect
    if (usingMultipart && session) {
      console.log('[ABORT on close]', session.uploadId);
      await s3.send(new AbortMultipartUploadCommand({
        Bucket: BUCKET, Key: session.key, UploadId: session.uploadId
      })).catch(() => {});
    }
  });
});
