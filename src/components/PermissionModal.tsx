import React from 'react';
import { motion } from 'motion/react';
import { MicOff, AlertCircle, Share2 } from 'lucide-react';

interface Props {
  onClose: () => void;
  onTypeInstead?: () => void;
  errorMessage?: string;
}

export default function PermissionModal({ onClose, onTypeInstead, errorMessage }: Props) {
  const isIframe = window.self !== window.top;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4">
      <motion.div 
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        className="w-full max-w-md bg-[#111] border border-white/10 rounded-3xl p-8 shadow-2xl flex flex-col items-center text-center relative overflow-hidden"
      >
        <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-red-500 to-orange-500" />
        
        <div className="w-16 h-16 rounded-full bg-red-400/10 flex items-center justify-center mb-5 border border-red-500/20">
          <MicOff size={28} className="text-red-400" />
        </div>
        
        <h2 className="text-2xl font-serif font-medium text-white mb-2">Microphone Blocked</h2>
        
        {isIframe ? (
          <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4 text-left w-full mb-5 text-amber-200">
            <p className="text-xs font-semibold flex items-center gap-1.5 mb-1 text-amber-400 uppercase tracking-wider font-mono">
              <Share2 size={12} /> Running in Iframe Sandbox
            </p>
            <p className="text-xs leading-relaxed opacity-90">
              Web browsers block microphone access inside development editor previews (Iframes) by default. 
              Please click the <strong>"Open in new tab"</strong> button at the top-right of your preview frame to launch standalone.
            </p>
          </div>
        ) : (
          <p className="text-white/60 text-sm mb-5 leading-relaxed">
            Your browser has blocked microphone access for this site. Zoya cannot hear you until you grant permission.
          </p>
        )}
        
        <div className="bg-white/5 border border-white/10 rounded-xl p-4 text-left w-full mb-6 text-white/80">
          <p className="text-xs font-mono uppercase tracking-wider text-white/40 mb-2 font-medium">How to allow microphone:</p>
          <ol className="text-xs list-decimal pl-4 space-y-1.5 text-white/70">
            <li>Click the <strong>lock icon (🔒)</strong> or <strong>site settings (⚙️)</strong> in your browser's address/URL bar.</li>
            <li>Change the <strong>Microphone</strong> setting to <strong>Allow</strong>.</li>
            <li>Refresh the page to apply the settings.</li>
          </ol>
        </div>

        {errorMessage && (
          <div className="bg-red-500/5 border border-red-500/10 rounded-xl p-3 text-left w-full mb-6 font-mono text-[10px] text-red-300 flex gap-2 items-start">
            <AlertCircle size={12} className="text-red-400 shrink-0 mt-0.5" />
            <div className="break-all">
              <span className="font-bold uppercase">System Error:</span> {errorMessage}
            </div>
          </div>
        )}
        
        <div className="flex flex-col w-full gap-3">
          <button 
            onClick={() => window.location.reload()}
            className="w-full py-3 px-4 bg-white text-black font-semibold rounded-xl hover:bg-gray-200 transition-all active:scale-98 cursor-pointer"
          >
            Refresh Page
          </button>
          
          {onTypeInstead && (
            <button 
              onClick={onTypeInstead}
              className="w-full py-3 px-4 bg-gradient-to-r from-violet-600 to-pink-600 text-white font-semibold rounded-xl hover:scale-102 transition-transform active:scale-98 cursor-pointer shadow-lg shadow-violet-500/15"
            >
              Type with Keyboard Instead
            </button>
          )}

          <button 
            onClick={onClose}
            className="w-full py-1.5 px-4 bg-white/5 text-white/70 font-medium rounded-xl hover:bg-white/10 transition-colors active:scale-98 cursor-pointer text-xs"
          >
            Cancel
          </button>
        </div>
      </motion.div>
    </div>
  );
}

