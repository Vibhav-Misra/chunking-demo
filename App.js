import React, { useRef, useState, useEffect } from 'react';

// =====================
// CONFIGURATION CONSTANTS
// =====================
// URL of the WebSocket server for coordinating multipart uploads
const WS_URL = 'ws://localhost:8080';
// Interval (in ms) at which MediaRecorder emits dataavailable events
const MEDIA_REC_INTERVAL_MS = 1000;
// Maximum size (in bytes) of each binary chunk sent over WebSocket
const CHUNK_SIZE = 256 * 1024;          // 256 KB
// Threshold (in bytes) of buffered data in WebSocket before applying backpressure
const BACKPRESSURE_HIGH = 4 * 1024 * 1024; // 4 MB

// Helper: slice a large ArrayBuffer into smaller chunks of given size
function sliceIntoChunks(arrayBuffer, size) {
  if (!size) return [arrayBuffer];
  const out = [];
  // Iterate through the buffer, slicing off `size` bytes at a time
  for (let o = 0; o < arrayBuffer.byteLength; o += size) {
    out.push(arrayBuffer.slice(o, o + size));
  }
  return out;
}

function App() {
  // ================
  // Refs for DOM elements and long-lived objects
  // ================
  const videoRef = useRef(null);       // <video> element for playback
  const recorderRef = useRef(null);    // MediaRecorder instance
  const wsRef = useRef(null);          // WebSocket instance

  // Session gating: promise that resolves when upload session is ready
  const sessionReadyPromiseRef = useRef(null);
  const resolveSessionReadyRef = useRef(null);
  const sessionReadyRef = useRef(false);

  // ================
  // UI State Variables
  // ================
  const [status, setStatus] = useState('Idle');
  // status can be: Idle | Connecting | StartingUpload | Ready | Recording | Stopping | Completed | Error
  const [partsUploaded, setPartsUploaded] = useState(0);
  const [bytesSent, setBytesSent] = useState(0);          // cumulative bytes sent
  const [uploadKey, setUploadKey] = useState(null);       // S3 key returned by server
  const [errorMsg, setErrorMsg] = useState(null);

  // Clean up on unmount: stop media tracks & close socket
  useEffect(() => {
    return () => {
      cleanupMedia();
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  // Reset the session gating promise so callers can await new readiness
  const resetSessionPromise = () => {
    sessionReadyPromiseRef.current = new Promise(res => {
      resolveSessionReadyRef.current = res;
    });
    sessionReadyRef.current = false;
  };

  // ================
  // WebSocket Connection & Session Initialization
  // ================
  const startConnection = () => {
    // If already connected, do nothing
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) return;
    resetSessionPromise();
    setStatus('Connecting');
    setErrorMsg(null);

    // Open WebSocket to local server
    wsRef.current = new WebSocket(WS_URL);
    wsRef.current.binaryType = 'arraybuffer';
    
    // Upon opening, tell server to begin multipart upload session
    wsRef.current.onopen = () => {
      setStatus('StartingUpload');
      console.log('WS opened, sending start');
      wsRef.current.send(JSON.stringify({ type: 'start' }));
    };

    // Handle incoming control messages from server
    wsRef.current.onmessage = evt => {
      let msg;
      try {
        msg = JSON.parse(evt.data);
      } catch {
      // Non-JSON message; ignore
      return;
    }

    switch (msg.type) {
    case 'uploadInfo':
      setUploadKey(msg.key);
      if (!sessionReadyRef.current) {
        sessionReadyRef.current = true;
        resolveSessionReadyRef.current();
        setStatus('Ready');
      }
      break;

    case 'partAck':
      setPartsUploaded(n => n + 1);
      break;

    case 'completed':
      setStatus('Completed');
      break;

    case 'error':
      console.error('Server error:', msg.message);
      setErrorMsg(msg.message);
      if (status !== 'Recording') setStatus('Error');
      break;

    default:
      // ignore other message types
      break;
  }
};


    wsRef.current.onerror = e => {
      console.error('WS error', e);
      setErrorMsg('WebSocket error');
      setStatus('Error');
    };
    wsRef.current.onclose = () => {
      // If connection drops mid-record, stop locally
      if (status === 'Recording') {
        stopRecorderLocal();
        setErrorMsg('Connection lost during recording');
        setStatus('Error');
      }
    };
  };

  // Ensure sessionReadyPromise resolves before proceeding
  const ensureSessionReady = async () => {
    if (sessionReadyRef.current) return;
    await sessionReadyPromiseRef.current;
  };

  // ================
  // Start Recording & Streaming Chunks
  // ================
  const startRecording = async () => {
    try {
      // If not connected, we would call startConnection() here
      // await ensureSessionReady to ensure server has upload set up
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        //startConnection();
      }
      await ensureSessionReady(); 
      
      // Check MediaRecorder support
      if (!('MediaRecorder' in window)) {
        setErrorMsg('MediaRecorder not supported');
        setStatus('Error');
        return;
      }

      // Request video+audio stream
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      videoRef.current.srcObject = stream;
      await videoRef.current.play();

      // Choose the best supported mimeType
      const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
        ? 'video/webm;codecs=vp8'
        : 'video/webm';

      // Create MediaRecorder with target bitrates
      const recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: 2_500_000,
        audioBitsPerSecond: 96_000
      });
      recorderRef.current = recorder;
      setStatus('Recording');
      setPartsUploaded(0);
      setBytesSent(0);

      // Handle each emitted data chunk
      recorder.ondataavailable = async e => {
        if (e.data.size === 0) return;          // skip empty events
        if (!sessionReadyRef.current) return;   // ensure session is ready
        const buf = await e.data.arrayBuffer();
        // Break large buffer into smaller, fixed-size chunks
        const chunks = sliceIntoChunks(buf, CHUNK_SIZE);
        
        // Send each sub-chunk over WebSocket
        for (const c of chunks) {
          // Backpressure: wait if too much is buffered
          while (wsRef.current &&
                 wsRef.current.readyState === WebSocket.OPEN &&
                 wsRef.current.bufferedAmount > BACKPRESSURE_HIGH) {
            // Pause briefly to let buffer drain      
            await new Promise(r => setTimeout(r, 50));
          }
          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(c);
            setBytesSent(b => b + c.byteLength);
          } else {
            console.warn('Socket closed mid-send');
            break;
          }
        }
      };

      // Start recording, emit data every MEDIA_REC_INTERVAL_MS
      recorder.start(MEDIA_REC_INTERVAL_MS);
    } catch (err) {
      console.error(err);
      setErrorMsg(err.message);
      setStatus('Error');
    }
  };

  // Stop recorder instance and clean up media tracks
  const stopRecorderLocal = () => {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop();
    }
    cleanupMedia();
  };

  // Stop all media tracks and remove srcObject
  const cleanupMedia = () => {
    const v = videoRef.current;
    if (v && v.srcObject) {
      v.srcObject.getTracks().forEach(t => t.stop());
      v.srcObject = null;
    }
  };

  // ================
  // Stop Recording & Finalize Upload
  // ================
  const stopRecording = () => {
    if (status !== 'Recording') return;
    setStatus('Stopping');
    stopRecorderLocal();
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      // Tell server we're done sending
      wsRef.current.send(JSON.stringify({ type: 'stop' }));
      sessionReadyRef.current = false;
    }
  };

  // Determine which buttons should be enabled based on status
  const canConnect = ['Idle', 'Error', 'Completed'].includes(status);
  const canRecord = status === 'Ready';
  const canStop = status === 'Recording';

  // ================
  // UI Rendering
  // ================
  return (
    <div style={{ padding: 20, maxWidth: 640 }}>
      <h2>Real-time Recording → Multipart S3 Upload</h2>
      <video
        ref={videoRef}
        style={{ width: 480, border: '1px solid #ccc', background:'#000' }}
        playsInline
        muted
      />
      <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
        <button onClick={startConnection} disabled={!canConnect}>Connect</button>
        <button onClick={startRecording} disabled={!canRecord}>Record</button>
        <button onClick={stopRecording} disabled={!canStop}>Stop</button>
      </div>

      {/* Display current status and metrics */}
      <p><strong>Status:</strong> {status}</p>
      {errorMsg && <p style={{ color:'red' }}>Error: {errorMsg}</p>}
      <p>Upload Key: {uploadKey || '(pending)'}</p>
      <p>Parts Uploaded: {partsUploaded}</p>
      <p>Bytes Sent: {(bytesSent / (1024 * 1024)).toFixed(2)} MB</p>
    </div>
  );
}

export default App;
