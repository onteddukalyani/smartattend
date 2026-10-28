import { Capacitor } from '@capacitor/core';
import { Kiosk } from '../plugins/kiosk/index.js';

/**
 * SmartAttend VPN & Network Security Detection
 * 
 * Verifies that the client device is not operating behind an active VPN tunnel,
 * network proxy, or spoofed interface during attendance sessions.
 * 
 * Multi-layer detection:
 * 1. Native Mobile Platform Check (authoritative via OS ConnectivityManager & interface scan)
 * 2. WebRTC Virtual Interface / Local Candidate Subnet Analysis
 * 3. Network Interface Pattern Matching (tun*, tap*, ppp*, vpn*, ipsec*, wireguard*, etc.)
 */
let cachedVpnStatus = null;
let cachedVpnTimestamp = 0;
const VPN_CACHE_TTL_MS = 10000;

/**
 * Clear any cached VPN status to force a fresh verification.
 */
export function clearVpnStatusCache() {
  cachedVpnStatus = null;
  cachedVpnTimestamp = 0;
}

export async function checkVpnAndNetworkSecurity(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedVpnStatus && (now - cachedVpnTimestamp) < VPN_CACHE_TTL_MS) {
    return cachedVpnStatus;
  }

  // 1. Native Mobile Platform Check (authoritative via OS ConnectivityManager & interface scan)
  if (Capacitor.isNativePlatform()) {
    try {
      const nativeRes = await Kiosk.isVpnActive();
      if (nativeRes && nativeRes.isVpn) {
        const res = {
          isVpn: true,
          reason: `Active VPN tunnel detected on device (${nativeRes.details || 'OS_TRANSPORT_VPN'})`,
          details: nativeRes.details || 'NATIVE_VPN',
          checkedAt: Date.now()
        };
        cachedVpnStatus = res;
        cachedVpnTimestamp = Date.now();
        return res;
      }
    } catch (err) {
      console.warn('[VpnDetection] Native VPN check notice:', err);
    }
  }

  // 2. Web / Browser WebRTC ICE Candidate Virtual Adapter Analysis
  try {
    const webRtcResult = await checkWebRtcVpnInterface();
    if (webRtcResult && webRtcResult.isVpn) {
      cachedVpnStatus = webRtcResult;
      cachedVpnTimestamp = Date.now();
      return webRtcResult;
    }
  } catch (err) {
    console.warn('[VpnDetection] WebRTC VPN check notice:', err);
  }

  const cleanResult = {
    isVpn: false,
    reason: 'No active VPN detected',
    details: 'CLEAN',
    checkedAt: Date.now()
  };
  cachedVpnStatus = cleanResult;
  cachedVpnTimestamp = Date.now();
  return cleanResult;
}

/**
 * Inspect WebRTC ICE candidates for virtual VPN interface identifiers and subnets.
 */
function checkWebRtcVpnInterface() {
  return new Promise((resolve) => {
    if (typeof window === 'undefined') {
      return resolve({ isVpn: false });
    }

    const RTCPeerConnection = window.RTCPeerConnection || window.webkitRTCPeerConnection || window.mozRTCPeerConnection;
    if (!RTCPeerConnection) {
      return resolve({ isVpn: false });
    }

    let resolved = false;
    let pc = null;

    const cleanup = () => {
      if (pc) {
        try { pc.close(); } catch (_) { }
        pc = null;
      }
    };

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup();
        resolve({ isVpn: false, details: 'CLEAN_TIMEOUT' });
      }
    }, 550);

    try {
      pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
      });

      pc.onicecandidate = (event) => {
        if (!event || !event.candidate) return;
        const candidateStr = (event.candidate.candidate || '').toLowerCase();

        // Check for virtual network adapter names, tunneling protocols or well-known VPN IP ranges
        const isVpnCandidate =
          candidateStr.includes('tun') ||
          candidateStr.includes('tap') ||
          candidateStr.includes('ppp') ||
          candidateStr.includes('vpn') ||
          candidateStr.includes('ipsec') ||
          candidateStr.includes('wireguard') ||
          candidateStr.includes('openvpn') ||
          candidateStr.includes('tailscale') ||
          candidateStr.includes('zerotier') ||
          candidateStr.includes('nord') ||
          candidateStr.includes('surfshark') ||
          candidateStr.includes('expressvpn') ||
          candidateStr.includes('proton') ||
          candidateStr.includes('10.8.') || // Default OpenVPN server subnet
          candidateStr.includes('10.9.') || // Default Wireguard server subnet
          candidateStr.includes('10.6.');

        if (isVpnCandidate && !resolved) {
          resolved = true;
          clearTimeout(timer);
          cleanup();
          resolve({
            isVpn: true,
            reason: 'Virtual VPN network adapter detected via WebRTC ICE check',
            details: 'WEBRTC_VPN_ADAPTER',
            checkedAt: Date.now()
          });
        }
      };

      pc.createDataChannel('smartattend_vpn_probe');
      pc.createOffer()
        .then((offer) => {
          if (pc && !resolved) {
            return pc.setLocalDescription(offer);
          }
        })
        .catch(() => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            cleanup();
            resolve({ isVpn: false });
          }
        });
    } catch (_) {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        cleanup();
        resolve({ isVpn: false });
      }
    }
  });
}
