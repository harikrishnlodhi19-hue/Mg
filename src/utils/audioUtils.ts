let sharedAudioCtx: AudioContext | null = null;

export function initAudio() {
  if (!sharedAudioCtx) {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (AudioContextClass) {
      sharedAudioCtx = new AudioContextClass({ sampleRate: 24000 });
      if (sharedAudioCtx.state === "suspended") {
        sharedAudioCtx.resume().catch(e => console.warn("Failed to resume audio ctx on init", e));
      }
    }
  }
}

export async function playPCM(base64Data: string): Promise<void> {
  try {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) {
      console.warn("AudioContext not supported");
      return;
    }
    
    if (!sharedAudioCtx) {
      sharedAudioCtx = new AudioContextClass({ sampleRate: 24000 });
    }
    
    // Auto-resume if suspended due to browser Autoplay policies
    if (sharedAudioCtx.state === "suspended") {
      await sharedAudioCtx.resume();
    }

    const binaryString = atob(base64Data);
    const len = binaryString.length;
    
    // Ensure even byte length to avoid RangeError in Int16Array
    const alignedLen = len - (len % 2);
    if (alignedLen === 0) return;

    const bytes = new Uint8Array(alignedLen);
    for (let i = 0; i < alignedLen; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    
    const buffer = new Int16Array(bytes.buffer);
    const audioBuffer = sharedAudioCtx.createBuffer(1, buffer.length, 24000);
    const channelData = audioBuffer.getChannelData(0);
    for (let i = 0; i < buffer.length; i++) {
      channelData[i] = buffer[i] / 32768.0;
    }
    
    const source = sharedAudioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(sharedAudioCtx.destination);
    source.start();
    
    return new Promise<void>(resolve => {
      source.onended = () => resolve();
    });
  } catch (error) {
    console.error("Error playing audio:", error);
  }
}
