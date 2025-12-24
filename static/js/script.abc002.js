const video = document.getElementById('video');
let greenAnimationRunning = false;
const animationDuration = 2000;
let animationFrameId = null;
let isFrameCaptureAborted = false;
var visibleVideoFrame = null;
var uploading = false;
var onPage = 1;
var captured_customer_photo = false;
var isCamSwitched = false;

let currentStream = null;
let isMobileDevice = false;

// NEW: Store uploaded reference image
let uploadedReferenceImage = null;
let uploadedImageDescriptor = null;
// Track upload processing state
let isUploadProcessing = false;
let isUploadReady = false;

// NEW: analysis timer + cameraStopped flag (for stop/restart)
let analysisTimer = null;
let cameraStopped = false;

// Timer tracking for each checklist item
let checkItemTimers = [
    { lastUncheckedTime: null, isBlinking: false, blinkIntervalId: null, originalBackground: null },
    { lastUncheckedTime: null, isBlinking: false, blinkIntervalId: null, originalBackground: null },
    { lastUncheckedTime: null, isBlinking: false, blinkIntervalId: null, originalBackground: null },
    { lastUncheckedTime: null, isBlinking: false, blinkIntervalId: null, originalBackground: null }
];
const UNCHECKED_TIMEOUT = 10000;
const BLINK_DURATION = 2500;

// Rule toggle states
let ruleToggles = {
    eyes: true,
    single: true,
    straight: true,
    frame: true
};

// Toggle button functionality
function initializeToggles() {
    const toggles = document.querySelectorAll('.toggle-switch');
    toggles.forEach(toggle => {
        toggle.addEventListener('click', function () {
            const rule = this.getAttribute('data-rule');
            const isEnabled = !this.classList.contains('disabled');

            if (isEnabled) {
                this.classList.add('disabled');
                ruleToggles[rule] = false;
                updateUIForRule(rule, false);
            } else {
                this.classList.remove('disabled');
                ruleToggles[rule] = true;
                updateUIForRule(rule, true);
            }
        });
    });
}

// Update UI elements when toggle changes
function updateUIForRule(rule, enabled) {
    const ruleIndexMap = {
        'eyes': 0,
        'single': 1,
        'straight': 2,
        'frame': 3
    };

    const index = ruleIndexMap[rule];
    const checklistItems = document.querySelectorAll('#checklist li');
    const instructionItems = document.querySelectorAll('#instructions li');
    const ovalSvg = document.getElementById('oval-svg');

    if (enabled) {
        if (checklistItems[index]) {
            checklistItems[index].classList.remove('faded');
        }
        if (instructionItems[index]) {
            instructionItems[index].classList.remove('faded');
        }

        if (rule === 'frame' && ovalSvg) {
            ovalSvg.classList.remove('hidden');
        }
    } else {
        if (checklistItems[index]) {
            checklistItems[index].classList.add('faded');
        }
        if (instructionItems[index]) {
            instructionItems[index].classList.add('faded');
        }

        if (rule === 'frame' && ovalSvg) {
            ovalSvg.classList.add('hidden');
        }

        if (checkItemTimers[index]) {
            checkItemTimers[index].lastUncheckedTime = null;

            if (checkItemTimers[index].isBlinking) {
                const elem = instructionItems[index];
                if (checkItemTimers[index].blinkIntervalId) {
                    clearInterval(checkItemTimers[index].blinkIntervalId);
                    checkItemTimers[index].blinkIntervalId = null;
                }
                if (elem) {
                    elem.style.background = checkItemTimers[index].originalBackground || '';
                }
                checkItemTimers[index].isBlinking = false;
                checkItemTimers[index].originalBackground = null;
            }
        }
    }
}

// Detect if device is mobile
function checkIfMobile() {
    isMobileDevice = window.innerWidth <= 768 ||
        /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    return isMobileDevice;
}

document.getElementById('customer-photo-btn').addEventListener('click', async function () {
    this.classList.add('selected');

    document.getElementById('rules-container').style.display = 'block';
    document.getElementById('face-overlay').style.display = 'block';
    onPage = 1;
    video.style.transform = 'translate(-50%, -50%) scaleX(-1) scale(1.5)';
    await startCamera('user');

    setTimeout(() => {
        setupOverlayFace();
        getVisibleVideoFrameCoordinatesCaller();
    }, 500);
});

async function setFocusMode(track, focusMode) {
    const capabilities = track.getCapabilities();
    if (capabilities.focusMode && capabilities.focusMode.includes(focusMode)) {
        try {
            await track.applyConstraints({ advanced: [{ focusMode: focusMode }] });
            console.log(`Focus mode set to ${focusMode}`);
        } catch (err) {
            console.warn('Failed to set focus mode:', err);
        }
    } else {
        console.log('Focus mode control not supported by this device');
    }
}

// Modified startCamera: keep existing behavior, but update cameraStopped and ensure previous stream is stopped
async function startCamera(facingMode) {
    // stop existing stream if present
    if (currentStream) {
        try {
            currentStream.getTracks().forEach(track => track.stop());
        } catch (e) {
            console.warn('Error stopping previous stream tracks', e);
        }
        currentStream = null;
    }
    try {
        let stream = null;
        if (facingMode == "user") {
            const constraints = {
                video: {
                    facingMode: facingMode,
                    width: { ideal: isMobileDevice ? 1280 : 1920 },
                    height: { ideal: isMobileDevice ? 720 : 1080 }
                },
                audio: false
            };
            stream = await navigator.mediaDevices.getUserMedia(constraints);
        } else {
            stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: facingMode,
                    width: { min: 1280, ideal: 3000, max: 5000 },
                    height: { min: 720, ideal: 4000, max: 10000 }
                },
                audio: false
            });
        }
        currentStream = stream;
        video.srcObject = stream;

        await new Promise((resolve) => {
            video.onloadedmetadata = () => {
                video.play();
                resolve();
            };
        });

        cameraStopped = false;

        // start analysis interval if not already running
        if (!analysisTimer) {
            const interval = isMobileDevice ? 400 : 300;
            analysisTimer = setInterval(analyzeFrame, interval);
        }

        if (isMobileDevice) {
            setTimeout(() => {
                setupOverlayFace();
                getVisibleVideoFrameCoordinatesCaller();
            }, 300);
        }

        const videoTrack = stream.getVideoTracks()[0];
        setFocusMode(videoTrack, 'continuous');
    } catch (error) {
        console.error("Error accessing camera:", error);
        showToast("Unable to access camera: " + (error.message || error), 3000);
    }
}

// NEW: stopCamera to pause video, stop tracks, clear analyze interval and cancel animations
function stopCamera() {
    try {
        // Clear analysis interval
        if (analysisTimer) {
            clearInterval(analysisTimer);
            analysisTimer = null;
        }

        // Cancel any running animation frame for dot animation
        if (animationFrameId) {
            try { cancelAnimationFrame(animationFrameId); } catch (e) { /* ignore */ }
            animationFrameId = null;
        }

        // Mark that camera is stopped
        cameraStopped = true;

        // Stop all tracks
        if (currentStream) {
            try {
                currentStream.getTracks().forEach(track => {
                    try { track.stop(); } catch (e) { /* ignore per-track errors */ }
                });
            } catch (e) {
                console.warn('stopCamera: error stopping tracks', e);
            }
            currentStream = null;
        }

        // Pause and clear video element
        if (video) {
            try { video.pause(); } catch (e) {}
            try { video.srcObject = null; } catch (e) {}
        }

        // If green animation was running, abort it
        if (greenAnimationRunning) {
            isFrameCaptureAborted = true;
            greenAnimationRunning = false;
        }
    } catch (e) {
        console.error('stopCamera error', e);
    }
}

// STARTUP: load models, then camera
(async function () {
    try {
        checkIfMobile();

        // 1) Load required models (detection + landmarks)
        await Promise.all([
            faceapi.nets.tinyFaceDetector.loadFromUri('static/models'),
            faceapi.nets.faceLandmark68Net.loadFromUri('static/models'),
        ]);

        // 2) Try loading recognition model, but do NOT block camera if it fails
        try {
            await faceapi.nets.faceRecognitionNet.loadFromUri('static/models');
            console.log('faceRecognitionNet loaded successfully');
        } catch (err) {
            console.warn('faceRecognitionNet failed to load. Face matching will be disabled.', err);
            showToast('Face match model not found — capture will still work.', 4000);
        }

        // 3) Start camera regardless
        await startCamera('user');

        // 4) Setup overlay after camera is live
        setTimeout(() => {
            setupOverlayFace();
            getVisibleVideoFrameCoordinatesCaller();
        }, 1000);
    } catch (err) {
        console.error('Error initializing models/camera:', err);
        showToast('Failed to initialize camera: ' + (err.message || err), 5000);
    }
})();


function veryFaceLikePath(w, h) {
    const cx = w / 2;
    const cy = h / 2;

    let ry = h * (isMobileDevice ? 0.35 : 0.40);
    let rx = w * (isMobileDevice ? 0.35 : 0.40);

    if (rx > ry)
        rx = ry;
    else
        ry = rx;

    return `
        M ${cx} ${cy - ry}
        A ${rx} ${ry} 0 1 1 ${cx} ${cy + ry}
        A ${rx} ${ry} 0 1 1 ${cx} ${cy - ry}
        Z
    `;
}

function placeDottedPath(svg, pathStr, numDots) {
    // Clear previously added dot circles to avoid duplicates and to ensure color reset
    try {
        // remove only circle elements (dots) while preserving any masks/rects/paths used for overlay
        const existingDots = Array.from(svg.querySelectorAll('circle'));
        existingDots.forEach(d => d.remove());
    } catch (e) {
        // ignore any DOM traversal errors
    }

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", pathStr);
    path.setAttribute("fill", "none");
    svg.appendChild(path);
    const len = path.getTotalLength();
    let dots = [];

    const dotRadius = isMobileDevice ? 4 : 6;

    for (let i = 0; i < numDots; i++) {
        const pt = path.getPointAtLength((i / numDots) * len);
        const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        dot.setAttribute("cx", pt.x);
        dot.setAttribute("cy", pt.y);
        dot.setAttribute("r", dotRadius);
        dot.setAttribute("fill", "red"); // default color red
        svg.appendChild(dot);
        dots.push(dot);
    }
    path.remove();
    return dots;
}

function drawMaskedOverlay(svg, pathStr, w, h) {
    const mask = document.createElementNS("http://www.w3.org/2000/svg", "mask");
    mask.setAttribute("id", "oval-mask");
    let rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", 0); rect.setAttribute("y", 0);
    rect.setAttribute("width", w);
    rect.setAttribute("height", h);
    rect.setAttribute("fill", "white");
    mask.appendChild(rect);
    let facePath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    facePath.setAttribute("d", pathStr);
    facePath.setAttribute("fill", "black");
    mask.appendChild(facePath);
    svg.appendChild(mask);
    let overlayRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    overlayRect.setAttribute("x", 0);
    overlayRect.setAttribute("y", 0);
    overlayRect.setAttribute("width", w);
    overlayRect.setAttribute("height", h);
    overlayRect.setAttribute("fill", "rgba(60,60,60,0.75)");
    overlayRect.setAttribute("mask", "url(#oval-mask)");
    overlayRect.setAttribute("pointer-events", "none");
    svg.appendChild(overlayRect);
}

function animateDots(dots, duration = animationDuration, colorOn = 'green', colorOff = 'red', onComplete) {
    if (animationFrameId) cancelAnimationFrame(animationFrameId);
    let start = null;
    function step(ts) {
        if (!start) start = ts;
        let t = Math.min(1, (ts - start) / duration);
        for (let i = 0; i < dots.length; i++) {
            dots[i].setAttribute('fill', t > i / dots.length ? colorOn : colorOff);
        }
        if (t < 1) {
            animationFrameId = requestAnimationFrame(step);
        } else {
            animationFrameId = null;
            if (onComplete) onComplete();
        }
    }
    animationFrameId = requestAnimationFrame(step);
}

function setupOverlayFace() {
    const svg = document.getElementById('oval-svg');
    const container = document.getElementById('camera-container');

    if (!svg || !container) {
        console.warn('SVG or container not found');
        return;
    }

    // Clear svg so we rebuild mask + dots cleanly
    svg.innerHTML = "";

    const containerRect = container.getBoundingClientRect();
    const w = Math.max(containerRect.width, 100);
    const h = Math.max(containerRect.height, 100);

    svg.style.position = 'absolute';
    svg.style.top = '0';
    svg.style.left = '0';
    svg.style.width = '100%';
    svg.style.height = '100%';
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('preserveAspectRatio', 'none');

    const pathStr = veryFaceLikePath(w, h);
    drawMaskedOverlay(svg, pathStr, w, h);
    const dots = placeDottedPath(svg, pathStr, isMobileDevice ? 180 : 250);
    dots.forEach(dot => dot.setAttribute('fill', 'red'));

    console.log('Overlay setup complete:', { w, h, isMobile: isMobileDevice });
}

function getVisibleVideoFrameCoordinates() {
    const video = document.getElementById('video');
    const container = document.getElementById('camera-container');

    if (!video || !container || !video.videoWidth || !video.videoHeight) {
        return null;
    }

    const videoRect = video.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();

    const visibleRect = {
        left: Math.max(videoRect.left, containerRect.left),
        top: Math.max(videoRect.top, containerRect.top),
        right: Math.min(videoRect.right, containerRect.right),
        bottom: Math.min(videoRect.bottom, containerRect.bottom),
    };

    const visibleWidth = visibleRect.right - visibleRect.left;
    const visibleHeight = visibleRect.bottom - visibleRect.top;

    if (visibleWidth <= 0 || visibleHeight <= 0) {
        return null;
    }

    const offsetX = visibleRect.left - videoRect.left;
    const offsetY = visibleRect.top - videoRect.top;
    const scaleX = video.videoWidth / videoRect.width;
    const scaleY = video.videoHeight / videoRect.height;

    const visibleVideoFrame = {
        x: offsetX * scaleX,
        y: offsetY * scaleY,
        width: visibleWidth * scaleX,
        height: visibleHeight * scaleY,
    };

    return visibleVideoFrame;
}

function getVisibleVideoFrameCoordinatesCaller() {
    visibleVideoFrame = getVisibleVideoFrameCoordinates();
    if (visibleVideoFrame && video.style.transform.includes('scaleX(-1)')) {
        visibleVideoFrame.x = video.videoWidth - (visibleVideoFrame.x + visibleVideoFrame.width);
    }
}

// Image Upload Handlers
function initializeImageUpload() {
    const uploadArea = document.getElementById('uploadArea');
    const fileInput = document.getElementById('imageUpload');
    const placeholder = document.getElementById('uploadPlaceholder');
    const preview = document.getElementById('uploadPreview');
    const previewImage = document.getElementById('previewImage');
    const removeBtn = document.getElementById('removeBtn');

    // Click to upload
    uploadArea.addEventListener('click', (e) => {
        if (!e.target.closest('.remove-btn')) {
            fileInput.click();
        }
    });

    // Drag and drop
    uploadArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadArea.style.borderColor = '#d00008';
        uploadArea.style.background = '#fff5f5';
    });

    uploadArea.addEventListener('dragleave', (e) => {
        e.preventDefault();
        uploadArea.style.borderColor = '#b00006';
        uploadArea.style.background = 'white';
    });

    uploadArea.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadArea.style.borderColor = '#b00006';
        uploadArea.style.background = 'white';

        const files = e.dataTransfer.files;
        if (files.length > 0) {
            handleImageFile(files[0]);
        }
    });

    // File input change
    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleImageFile(e.target.files[0]);
        }
    });

    // Remove button
    removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        clearUploadedImage();
    });
}

async function handleImageFile(file) {
    if (!file.type.startsWith('image/')) {
        showToast('Please upload a valid image file', 3000);
        return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
            // Show preview in UI
            document.getElementById('previewImage').src = e.target.result;
            document.getElementById('uploadPlaceholder').style.display = 'none';
            document.getElementById('uploadPreview').style.display = 'flex';

            // Just store the image – no heavy face processing here
            uploadedReferenceImage = img;

            showToast('Reference image uploaded successfully!', 2500);
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
}

function clearUploadedImage() {
    document.getElementById('previewImage').src = '';
    document.getElementById('uploadPlaceholder').style.display = 'flex';
    document.getElementById('uploadPreview').style.display = 'none';
    document.getElementById('imageUpload').value = '';
    uploadedReferenceImage = null;
}

window.addEventListener('DOMContentLoaded', () => {
    const splash = document.getElementById('splash-screen');
    const mainPage = document.getElementById('main-page');

    checkIfMobile();
    initializeToggles();
    initializeImageUpload(); // NEW

    let resizeTimeout;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
            checkIfMobile();
            setupOverlayFace();
            getVisibleVideoFrameCoordinatesCaller();
        }, 250);
    });

    window.addEventListener('orientationchange', () => {
        setTimeout(() => {
            checkIfMobile();
            setupOverlayFace();
            getVisibleVideoFrameCoordinatesCaller();
        }, 300);
    });

    setTimeout(() => {
        splash.classList.add('fade-out');
        splash.addEventListener('transitionend', () => {
            splash.style.display = 'none';
            mainPage.style.display = 'block';
            setTimeout(() => {
                setupOverlayFace();
                getVisibleVideoFrameCoordinatesCaller();
            }, 100);
        }, { once: true });
    }, 2000);
});

function checkItem(index) {
    const icons = document.querySelectorAll('#checklist .icon');
    if (icons[index]) {
        icons[index].setAttribute('data-status', 'complete');
    }
    checkItemTimers[index].lastUncheckedTime = null;
}

function unCheckItem(index) {
    if (!uploading) {
        const icons = document.querySelectorAll('#checklist .icon');
        if (icons[index]) {
            icons[index].setAttribute('data-status', 'incomplete');
        }
        if (checkItemTimers[index].lastUncheckedTime === null) {
            checkItemTimers[index].lastUncheckedTime = Date.now();
        }
    }
}

function blinkGuideline(index) {
    if (isMobileDevice) return;
    if (checkItemTimers[index].isBlinking) return;

    const instructionsList = document.querySelectorAll('#instructions li');
    if (!instructionsList[index]) return;

    checkItemTimers[index].isBlinking = true;
    const element = instructionsList[index];
    const originalBackground = element.style.background;

    checkItemTimers[index].originalBackground = originalBackground;

    let blinkCount = 0;
    const maxBlinks = 5;
    const blinkInterval = BLINK_DURATION / (maxBlinks * 2);

    const blinkTimer = setInterval(() => {
        if (!checkItemTimers[index] || checkItemTimers[index].isBlinking === false) {
            clearInterval(blinkTimer);
            checkItemTimers[index].blinkIntervalId = null;
            if (element) element.style.background = checkItemTimers[index] ? (checkItemTimers[index].originalBackground || '') : '';
            if (checkItemTimers[index]) {
                checkItemTimers[index].isBlinking = false;
                checkItemTimers[index].originalBackground = null;
            }
            return;
        }

        if (blinkCount >= maxBlinks * 2) {
            clearInterval(blinkTimer);
            checkItemTimers[index].blinkIntervalId = null;
            element.style.background = originalBackground;
            element.style.transition = 'background 0.2s';
            checkItemTimers[index].isBlinking = false;
            checkItemTimers[index].originalBackground = null;
            return;
        }

        if (blinkCount % 2 === 0) {
            element.style.background = 'gold';
            element.style.transition = 'background 0.15s';
        } else {
            element.style.background = 'rgba(255, 200, 0, 0.4)';
            element.style.transition = 'background 0.15s';
        }

        blinkCount++;
    }, blinkInterval);

    checkItemTimers[index].blinkIntervalId = blinkTimer;
}

function checkUncheckedTimers() {
    const now = Date.now();
    checkItemTimers.forEach((timer, index) => {
        if (timer.lastUncheckedTime !== null && !timer.isBlinking) {
            const elapsed = now - timer.lastUncheckedTime;
            if (elapsed >= UNCHECKED_TIMEOUT) {
                blinkGuideline(index);
                timer.lastUncheckedTime = now;
            }
        }
    });
}

setInterval(checkUncheckedTimers, 1000);

let maxEAR = 0;
let minEAR = 0.2;

function areEyesOpen(landmarks) {
    const leftEye = landmarks.getLeftEye();
    const rightEye = landmarks.getRightEye();
    function eyeAspectRatio(eye) {
        const A = Math.hypot(eye[1].x - eye[5].x, eye[1].y - eye[5].y);
        const B = Math.hypot(eye[2].x - eye[4].x, eye[2].y - eye[4].y);
        const C = Math.hypot(eye[0].x - eye[3].x, eye[0].y - eye[3].y);
        return (A + B) / (2.0 * C);
    }
    const leftEAR = eyeAspectRatio(leftEye);
    const rightEAR = eyeAspectRatio(rightEye);
    const currentEAR = (leftEAR + rightEAR) / 2;
    if (currentEAR > maxEAR) maxEAR = currentEAR;
    if (currentEAR < minEAR) minEAR = currentEAR;
    if (maxEAR > 0.35) maxEAR = 0.35
    const EAR_THRESHOLD = (maxEAR + minEAR) / 2;
    return (currentEAR > EAR_THRESHOLD);
}

function isFaceFrontal(landmarks) {
    const nose = landmarks.getNose()[3];
    const leftEye = landmarks.getLeftEye();
    const rightEye = landmarks.getRightEye();
    function average(points) {
        const sum = points.reduce((acc, pt) => ({ x: acc.x + pt.x, y: acc.y + pt.y }), { x: 0, y: 0 });
        return { x: sum.x / points.length, y: sum.y / points.length };
    }
    const leftEyeCenter = average(leftEye);
    const rightEyeCenter = average(rightEye);
    const midEyeX = (leftEyeCenter.x + rightEyeCenter.x) / 2;
    const deviation = nose.x - midEyeX;
    const eyeDy = Math.abs(leftEyeCenter.y - rightEyeCenter.y);

    const deviationThreshold = isMobileDevice ? 10 : 6;
    const eyeDyThreshold = isMobileDevice ? 15 : 10;

    return Math.abs(deviation) < deviationThreshold && eyeDy < eyeDyThreshold;
}

function isFaceInsideFrame(box) {
    if (!visibleVideoFrame || !box) return false;

    const svg = document.getElementById('oval-svg');
    if (!svg) return false;

    const w = svg.clientWidth;
    const h = svg.clientHeight;

    const cx = w / 2;
    const cy = h / 2;

    const baseRadiusMultiplier = isMobileDevice ? 0.10 : 0.40;

    const aspectFactor = (w > h ? 0.6 : 0.7);
    let rx = Math.max(1, (h * baseRadiusMultiplier * aspectFactor) * 0.88);
    let ry = Math.max(1, (h * baseRadiusMultiplier * aspectFactor) * 0.88);

    const scaleX = w / visibleVideoFrame.width;
    const scaleY = h / visibleVideoFrame.height;

    const boxOverlay = {
        x: (box.x - visibleVideoFrame.x) * scaleX,
        y: (box.y - visibleVideoFrame.y) * scaleY,
        width: box.width * scaleX,
        height: box.height * scaleY
    };

    if (boxOverlay.width <= 0 || boxOverlay.height <= 0) return false;

    function pointInsideEllipse(px, py) {
        const dx = (px - cx) / rx;
        const dy = (py - cy) / ry;
        return (dx * dx + dy * dy) <= 1;
    }

    const centerX = boxOverlay.x + boxOverlay.width / 2;
    const centerY = boxOverlay.y + boxOverlay.height / 2;
    if (pointInsideEllipse(centerX, centerY)) {
        const largeFaceRatio = Math.max(boxOverlay.width / w, boxOverlay.height / h);
        if (largeFaceRatio > 0.45) return true;
    }

    const areaRatio = (boxOverlay.width * boxOverlay.height) / (w * h);
    const grid = Math.min(30, Math.max(12, Math.round(12 + areaRatio * 100)));
    let inside = 0, total = 0;
    for (let i = 0; i < grid; i++) {
        for (let j = 0; j < grid; j++) {
            const px = boxOverlay.x + (i + 0.5) * (boxOverlay.width / grid);
            const py = boxOverlay.y + (j + 0.5) * (boxOverlay.height / grid);
            total++;
            if (pointInsideEllipse(px, py)) inside++;
        }
    }
    const fraction = total > 0 ? (inside / total) : 0;

    let threshold = isMobileDevice ? 0.70 : 0.80;
    const largeFaceRatio = Math.max(boxOverlay.width / w, boxOverlay.height / h);
    if (largeFaceRatio > 0.30) {
        threshold *= 0.7;
    } else if (largeFaceRatio > 0.35) {
        threshold *= 0.85;
    }

    return fraction >= threshold;
}

// Capture single frame from video
function captureSingleFrame(video) {
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas;
}

// Capture + compare uploaded vs live using TinyFaceDetector
async function processFaceMatch() {
    // 1) Make sure we HAVE an uploaded image
    if (!uploadedReferenceImage) {
        showToast('Please upload a reference image first!', 3000);
        uploading = false;
        hideProgressDialog();
        return;
    }

    showProgressDialog();

    try {
        // 2) Capture current video frame at full resolution
        const captureCanvas = captureSingleFrame(video);

        // Helper to resize for faster face-api
        function makeResizedCanvas(imgOrCanvas, maxSide = 400) {
            const srcW = imgOrCanvas.width;
            const srcH = imgOrCanvas.height;
            const scale = Math.min(1, maxSide / Math.max(srcW, srcH));
            const dstW = Math.round(srcW * scale);
            const dstH = Math.round(srcH * scale);
            const c = document.createElement('canvas');
            c.width = dstW;
            c.height = dstH;
            const ctx = c.getContext('2d');
            ctx.drawImage(imgOrCanvas, 0, 0, dstW, dstH);
            return c;
        }

        // 3) Build resized canvases for both images
        const uploadedCanvas = makeResizedCanvas(uploadedReferenceImage);
        const liveCanvas = makeResizedCanvas(captureCanvas);

        // 4) Detect face + descriptor on uploaded image
        const uploadedDet = await faceapi
            .detectSingleFace(uploadedCanvas, new faceapi.TinyFaceDetectorOptions())
            .withFaceLandmarks()
            .withFaceDescriptor();

        if (!uploadedDet) {
            hideProgressDialog();
            showToast('No face detected in uploaded image. Please use a clearer face photo.', 4000);
            uploading = false;
            return;
        }

        // 5) Detect face + descriptor on live capture
        const liveDet = await faceapi
            .detectSingleFace(liveCanvas, new faceapi.TinyFaceDetectorOptions())
            .withFaceLandmarks()
            .withFaceDescriptor();

        if (!liveDet) {
            hideProgressDialog();
            showToast('No face detected in captured frame. Please try again.', 3000);
            uploading = false;
            return;
        }

        // 6) Compare descriptors
        const distance = faceapi.euclideanDistance(
            uploadedDet.descriptor,
            liveDet.descriptor
        );

        // Distances around ~0.4 are usually "same person".
        // Distances near 1.0 are "very different".
        // Map 0.4 -> 100%, 1.0 -> 0% (clamped in between)
        const BEST_DISTANCE = 0.4;   // strong match
        const WORST_DISTANCE = 1.0;  // very different

        let normalized = (WORST_DISTANCE - distance) / (WORST_DISTANCE - BEST_DISTANCE);
        normalized = Math.max(0, Math.min(1, normalized));   // clamp 0..1
        const matchPercentage = Math.round(normalized * 100);

        // 7) Convert original full-res images to base64 for display
        const capturedImageBase64 = captureCanvas.toDataURL('image/jpeg', 0.92).split(',')[1];

        const fullUploadedCanvas = document.createElement('canvas');
        fullUploadedCanvas.width = uploadedReferenceImage.width;
        fullUploadedCanvas.height = uploadedReferenceImage.height;
        fullUploadedCanvas.getContext('2d').drawImage(
            uploadedReferenceImage,
            0, 0,
            fullUploadedCanvas.width,
            fullUploadedCanvas.height
        );
        const uploadedImageBase64 = fullUploadedCanvas.toDataURL('image/jpeg', 0.92).split(',')[1];

        hideProgressDialog();

        captured_customer_photo = true;

        // IMPORTANT: call showResult which now stops camera before showing modal
        showResult(
            matchPercentage >= 80
                ? 'Face Match Successful!'
                : 'Face Match Failed',
            capturedImageBase64,
            uploadedImageBase64,
            matchPercentage.toFixed(2)
        );

        uploading = false;
    } catch (error) {
        console.error('Error during face matching:', error);
        hideProgressDialog();
        showToast('Error during face matching. Please try again.', 3000);
        uploading = false;
    }
}

function showProgressDialog() {
    const dialog = document.getElementById('progress-dialog');
    if (dialog) dialog.style.display = 'flex';
}

function hideProgressDialog() {
    const dialog = document.getElementById('progress-dialog');
    if (dialog) dialog.style.display = 'none';
}

function showToast(message, duration = 2000) {
    const toast = document.createElement('div');
    toast.textContent = message;
    toast.style.position = 'fixed';
    toast.style.bottom = '30px';
    toast.style.left = '50%';
    toast.style.transform = 'translateX(-50%)';
    toast.style.backgroundColor = 'rgba(50,50,50,0.9)';
    toast.style.color = '#fff';
    toast.style.padding = '12px 24px';
    toast.style.borderRadius = '25px';
    toast.style.fontSize = '14px';
    toast.style.boxShadow = '0 2px 8px rgba(0,0,0,0.3)';
    toast.style.zIndex = 10001;
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s ease';

    document.body.appendChild(toast);

    requestAnimationFrame(() => {
        toast.style.opacity = '1';
    });

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.addEventListener('transitionend', () => {
            if (toast.parentNode) {
                toast.parentNode.removeChild(toast);
            }
        });
    }, duration);
}

// Modified showResult: stop camera when showing modal, restart on close and ensure overlay reset to red
function showResult(message, customerPhoto = null, uploadedPhoto = null, matchingScore = null) {
    // STOP camera and analysis while result modal is visible
    stopCamera();

    const overlay = document.createElement('div');
    overlay.style.position = 'fixed';
    overlay.style.top = 0;
    overlay.style.left = 0;
    overlay.style.width = '100vw';
    overlay.style.height = '100vh';
    overlay.style.backgroundColor = 'rgba(0,0,0,0.7)';
    overlay.style.display = 'flex';
    overlay.style.justifyContent = 'center';
    overlay.style.alignItems = 'center';
    overlay.style.zIndex = 10000;
    overlay.style.animation = 'fadeInOverlay 0.3s ease forwards';

    const modal = document.createElement('div');
    modal.style.background = '#fff';
    modal.style.padding = '30px 40px';
    modal.style.borderRadius = '12px';
    modal.style.boxShadow = '0 8px 24px rgba(0,0,0,0.2)';
    modal.style.textAlign = 'center';
    modal.style.maxWidth = '500px';
    modal.style.width = '90vw';
    modal.style.maxHeight = '85vh';
    modal.style.overflowY = 'auto';
    modal.style.fontFamily = "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif";
    modal.style.color = '#333';
    modal.style.animation = 'fadeInModal 0.4s ease forwards';
    modal.style.backgroundColor = (customerPhoto || uploadedPhoto) ? '#e6f9f1' : '#fdecea';

    const msgP = document.createElement('p');
    msgP.textContent = message;
    msgP.style.fontSize = '18px';
    msgP.style.marginBottom = '20px';
    msgP.style.fontWeight = '600';
    modal.appendChild(msgP);

    if (customerPhoto && uploadedPhoto) {
        const container = document.createElement('div');
        container.style.display = 'flex';
        container.style.gap = '10px';
        container.style.marginBottom = '15px';
        container.style.justifyContent = 'space-between';
        container.style.flexDirection = isMobileDevice ? 'column' : 'row';

        const createImageBlock = (title, base64) => {
            const block = document.createElement('div');
            block.style.flex = '1';
            block.style.textAlign = 'center';

            const img = new Image();
            img.src = `data:image/jpeg;base64,${base64}`;
            img.style.width = '100%';
            img.style.height = 'auto';
            img.style.borderRadius = '10px';
            img.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';

            const caption = document.createElement('div');
            caption.textContent = title;
            caption.style.fontWeight = '600';
            caption.style.fontSize = '14px';
            caption.style.color = '#555';
            caption.style.marginTop = '5px';

            block.appendChild(img);
            block.appendChild(caption);
            return block;
        };
        container.appendChild(createImageBlock("Captured Photo", customerPhoto));
        container.appendChild(createImageBlock("Reference Photo", uploadedPhoto));
        modal.appendChild(container);

        if (matchingScore !== null && matchingScore !== undefined) {
            const score = document.createElement('div');
            score.textContent = `Matching Score: ${parseFloat(matchingScore).toFixed(2)}%`;
            score.style.fontSize = '20px';
            score.style.fontWeight = '700';
            score.style.marginBottom = '20px';
            score.style.color = parseFloat(matchingScore) >= 80 ? '#25bf6c' : '#b00006';
            modal.appendChild(score);
        }
    }
    else if (customerPhoto) {
        const img = new Image();
        img.src = `data:image/jpeg;base64,${customerPhoto}`;
        img.style.width = '100%';
        img.style.height = 'auto';
        img.style.borderRadius = '10px';
        img.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
        img.style.marginBottom = '25px';
        modal.appendChild(img);
    }

    const okBtn = document.createElement('button');
    okBtn.textContent = 'OK';
    okBtn.style.backgroundColor = '#007bff';
    okBtn.style.color = '#fff';
    okBtn.style.border = 'none';
    okBtn.style.padding = '12px 30px';
    okBtn.style.fontSize = '16px';
    okBtn.style.fontWeight = '600';
    okBtn.style.borderRadius = '8px';
    okBtn.style.cursor = 'pointer';
    okBtn.style.transition = 'background-color 0.3s ease';
    okBtn.style.outline = 'none';
    okBtn.style.userSelect = 'none';
    okBtn.addEventListener('mouseenter', () => okBtn.style.backgroundColor = '#0056b3');
    okBtn.addEventListener('mouseleave', () => okBtn.style.backgroundColor = '#007bff');
    okBtn.addEventListener('click', () => {
        document.body.removeChild(overlay);
        uploading = false;
        if (animationFrameId) {
            try { cancelAnimationFrame(animationFrameId); } catch (e) {}
            animationFrameId = null;
        }
        // Restart camera after a short delay (only if we previously stopped it)
        if (cameraStopped) {
            setTimeout(() => {
                // restart camera
                startCamera('user').then(() => {
                    // rebuild overlay and ensure dots are red
                    setTimeout(() => {
                        setupOverlayFace();
                        getVisibleVideoFrameCoordinatesCaller();
                    }, 150);
                }).catch(err => {
                    console.warn('Failed to restart camera after modal close', err);
                });
            }, 120);
        }
    });
    modal.appendChild(okBtn);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const styleElem = document.createElement('style');
    styleElem.textContent = `
        @keyframes fadeInOverlay { from {opacity: 0;} to {opacity: 1;} }
        @keyframes fadeInModal { from {opacity: 0; transform: translateY(-20px);} to {opacity: 1; transform: translateY(0);} }
    `;
    document.head.appendChild(styleElem);
}

async function analyzeFrame() {
    if (onPage == 1) {
        const detections = await faceapi.detectAllFaces(video, new faceapi.TinyFaceDetectorOptions()).withFaceLandmarks();
        let allRulesPassed = true;

        if (ruleToggles.single) {
            if (detections.length === 1) {
                checkItem(1);
            } else {
                unCheckItem(1);
                allRulesPassed = false;
            }
        }

        if (detections.length > 0) {
            const detection = detections[0];
            const landmarks = detection.landmarks;

            if (ruleToggles.eyes) {
                if (areEyesOpen(landmarks)) {
                    checkItem(0);
                } else {
                    unCheckItem(0);
                    allRulesPassed = false;
                }
            }

            if (ruleToggles.straight) {
                if (isFaceFrontal(landmarks)) {
                    checkItem(2);
                } else {
                    unCheckItem(2);
                    allRulesPassed = false;
                }
            }

            if (ruleToggles.frame) {
                if (isFaceInsideFrame(detection.detection.box)) {
                    checkItem(3);
                } else {
                    unCheckItem(3);
                    allRulesPassed = false;
                }
            }
        } else {
            if (ruleToggles.eyes) unCheckItem(0);
            if (ruleToggles.single) unCheckItem(1);
            if (ruleToggles.straight) unCheckItem(2);
            if (ruleToggles.frame) unCheckItem(3);
            allRulesPassed = false;
        }

        if (!uploading) {
            if (allRulesPassed) {
                // Optional quick guard – not strictly required, but nicer UX
                if (!uploadedReferenceImage) {
                    showToast('Please upload a reference image first!', 3000);
                    return;
                }

                if (!greenAnimationRunning) {
                    greenAnimationRunning = true;
                    isFrameCaptureAborted = false;

                    const svg = document.getElementById('oval-svg');
                    const dots = placeDottedPath(
                        svg,
                        veryFaceLikePath(svg.clientWidth, svg.clientHeight),
                        isMobileDevice ? 180 : 250
                    );

                    animateDots(dots, animationDuration, 'green', 'red', async () => {
                        if (onPage == 1 && !isFrameCaptureAborted) {
                            uploading = true;
                            await processFaceMatch();
                            greenAnimationRunning = false;
                        } else {
                            greenAnimationRunning = false;
                        }
                    });
                }
            } else {
                if (greenAnimationRunning) {
                    isFrameCaptureAborted = true;
                    greenAnimationRunning = false;
                    if (animationFrameId) {
                        try { cancelAnimationFrame(animationFrameId); } catch (e) {}
                        animationFrameId = null;
                    }
                    const svg = document.getElementById('oval-svg');
                    const dots = placeDottedPath(svg, veryFaceLikePath(svg.clientWidth, svg.clientHeight), isMobileDevice ? 180 : 250);
                    dots.forEach(dot => dot.setAttribute('fill', 'red'));
                }
            }
        }
    }
}



const analysisInterval = isMobileDevice ? 400 : 300;
// START analysis interval using stored timer so we can clear it in stopCamera
if (!analysisTimer) {
    analysisTimer = setInterval(analyzeFrame, analysisInterval);
}

// Mobile Guidelines overlay handlers
function disableBodyScroll() {
    document.body.classList.add('no-scroll');
}
function enableBodyScroll() {
    document.body.classList.remove('no-scroll');
}
function showGuidelinesOverlay() {
    const overlay = document.getElementById('mobile-guidelines-overlay');
    if (!overlay) return;
    const rightPanel = document.getElementById('right-panel');
    const body = document.getElementById('mobile-guidelines-body');
    if (body && rightPanel) {
        body.innerHTML = rightPanel.innerHTML;
        body.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
    }
    overlay.style.display = 'flex';
    requestAnimationFrame(() => {
        overlay.setAttribute('aria-hidden', 'false');
        overlay.classList.add('visible');
    });
    disableBodyScroll();
    const closeBtn = document.getElementById('mobile-guidelines-close');
    if (closeBtn) closeBtn.focus();
}
function hideGuidelinesOverlay() {
    const overlay = document.getElementById('mobile-guidelines-overlay');
    if (!overlay) return;
    overlay.setAttribute('aria-hidden', 'true');
    overlay.classList.remove('visible');
    overlay.addEventListener('transitionend', function _h() {
        overlay.style.display = 'none';
        const body = document.getElementById('mobile-guidelines-body');
        if (body) body.innerHTML = '';
        overlay.removeEventListener('transitionend', _h);
    });
    enableBodyScroll();
}

document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('mobile-guidelines-btn');
    const closeBtn = document.getElementById('mobile-guidelines-close');
    if (btn) btn.addEventListener('click', showGuidelinesOverlay);
    if (closeBtn) closeBtn.addEventListener('click', hideGuidelinesOverlay);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            const overlay = document.getElementById('mobile-guidelines-overlay');
            if (overlay && overlay.classList.contains('visible')) {
                hideGuidelinesOverlay();
            }
        }
    });
});
