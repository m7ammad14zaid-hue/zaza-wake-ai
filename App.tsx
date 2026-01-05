
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { AppStatus, CharacterState, UserPreferences, Language, SleepStats, AlarmSoundType, ZazaVoiceType, Reminder } from './types';
import { storageService } from './services/storageService';
import { audioService } from './services/audioService';
import { TRANSLATIONS } from './constants';
import ZazaCharacter from './components/ZazaCharacter';
import Onboarding from './components/Onboarding';
import CameraVerification from './components/CameraVerification';
import { Clock, Moon, Sun, BarChart2, Settings, X, Timer, Mic, MicOff, PlusCircle, Play, Coffee, Volume2, UserCheck, Loader2, Sparkles, AlertCircle, ExternalLink, Bell, Trash2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { GoogleGenAI, Modality, LiveServerMessage, FunctionDeclaration, Type } from "@google/genai";

declare global {
  interface AIStudio {
    hasSelectedApiKey: () => Promise<boolean>;
    openSelectKey: () => Promise<void>;
  }
  interface Window {
    aistudio?: AIStudio;
    webkitAudioContext: typeof AudioContext;
  }
}

function encode(bytes: Uint8Array) {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function decode(base64: string) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binaryString.charCodeAt(i);
  return bytes;
}

async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number,
): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);
  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

const App: React.FC = () => {
  const [prefs, setPrefs] = useState<UserPreferences>(storageService.getPreferences());
  const [status, setStatus] = useState<AppStatus>(
    prefs.hasCompletedOnboarding ? AppStatus.DASHBOARD : AppStatus.ONBOARDING
  );
  const [charState, setCharState] = useState<CharacterState>(CharacterState.IDLE);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [startTime, setStartTime] = useState<number>(0);
  const [isLiveActive, setIsLiveActive] = useState(false);
  const [zazaResponding, setZazaResponding] = useState(false);
  const [isPreviewingVoice, setIsPreviewingVoice] = useState(false);
  const [apiError, setApiError] = useState<boolean>(false);
  
  const [timerRemaining, setTimerRemaining] = useState<number>(0);
  const timerIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const nextStartTimeRef = useRef(0);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const sessionRef = useRef<any>(null);
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  
  const [showStats, setShowStats] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showTimerModal, setShowTimerModal] = useState(false);
  const [showReminderModal, setShowReminderModal] = useState(false);
  const [customTimerValue, setCustomTimerValue] = useState("30");
  const [newReminderTime, setNewReminderTime] = useState("00:00");
  const [newReminderLabel, setNewReminderLabel] = useState("");

  const [isReminderFiring, setIsReminderFiring] = useState(false);
  const lastReminderTriggeredRef = useRef<string>("");

  const t = TRANSLATIONS[prefs.language];

  // Continuous Clock & Reminder Check
  useEffect(() => {
    const timer = setInterval(() => {
      const now = new Date();
      setCurrentTime(now);
      const currentTimeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
      
      if (currentTimeStr !== lastReminderTriggeredRef.current) {
        prefs.reminders.forEach(reminder => {
          if (reminder.active && reminder.time === currentTimeStr) {
            triggerZazaReminder(reminder);
            lastReminderTriggeredRef.current = currentTimeStr;
          }
        });
      }

      // Check for daily morning alarm
      if (status === AppStatus.SLEEPING && currentTimeStr === prefs.targetWakeTime) {
        triggerAlarm();
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [prefs.reminders, prefs.targetWakeTime, status]);

  // Alarm Sound Loop
  useEffect(() => {
    let alarmInterval: NodeJS.Timeout | null = null;
    if (status === AppStatus.ALARMING) {
      // Immediate play
      audioService.playAlarm(true, prefs.alarmSound);
      // Set loop
      alarmInterval = setInterval(() => {
        audioService.playAlarm(true, prefs.alarmSound);
        // Intensity: character taps faster/sound loops
        setCharState(CharacterState.TAPPING);
      }, 1500);
    }
    return () => {
      if (alarmInterval) clearInterval(alarmInterval);
    };
  }, [status, prefs.alarmSound]);

  const triggerZazaReminder = async (reminder: Reminder) => {
    setIsReminderFiring(true);
    audioService.playBedtimeReminder(); 
    setCharState(CharacterState.VIGOROUS);
    
    const userLabel = prefs.userName ? prefs.userName : '';
    const message = prefs.language === 'ar' 
      ? `يا ${userLabel}، حان وقت الـ ${reminder.label} الآن!` 
      : `Hey ${userLabel}, it is time for ${reminder.label} now!`;
    
    speakMessage(message);
    
    setTimeout(() => {
      setIsReminderFiring(false);
      setCharState(prev => prev === CharacterState.VIGOROUS ? CharacterState.IDLE : prev);
    }, 30000);
  };

  const stopReminderAction = () => {
    setIsReminderFiring(false);
    setCharState(CharacterState.IDLE);
    activeSourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
    activeSourcesRef.current.clear();
    return "ok";
  };

  const speakMessage = async (msg: string) => {
    if (!outputAudioContextRef.current) {
      outputAudioContextRef.current = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
    }
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts",
        contents: [{ parts: [{ text: msg }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: prefs.zazaVoice } } },
        },
      });
      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (base64Audio) {
        const audioBuffer = await decodeAudioData(decode(base64Audio), outputAudioContextRef.current, 24000, 1);
        const source = outputAudioContextRef.current.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(outputAudioContextRef.current.destination);
        source.start();
        activeSourcesRef.current.add(source);
        source.onended = () => activeSourcesRef.current.delete(source);
      }
    } catch (e) { console.error(e); }
  };

  const previewZazaVoice = async (voice: ZazaVoiceType) => {
    setIsPreviewingVoice(true);
    const msg = prefs.language === 'ar' ? "مرحباً، أنا زازا." : "Hello, I am Zaza.";
    if (!outputAudioContextRef.current) {
      outputAudioContextRef.current = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
    }
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts",
        contents: [{ parts: [{ text: msg }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        },
      });
      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (base64Audio) {
        const audioBuffer = await decodeAudioData(decode(base64Audio), outputAudioContextRef.current, 24000, 1);
        const source = outputAudioContextRef.current.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(outputAudioContextRef.current.destination);
        source.onended = () => setIsPreviewingVoice(false);
        source.start();
      } else { setIsPreviewingVoice(false); }
    } catch (e) { setIsPreviewingVoice(false); handleVoiceActivation(); }
  };

  const handleOnboardingComplete = (newPrefs: UserPreferences) => {
    storageService.savePreferences(newPrefs);
    setPrefs(newPrefs);
    setStatus(AppStatus.DASHBOARD);
  };

  const handleVoiceActivation = async () => {
    try { if (window.aistudio) { await window.aistudio.openSelectKey(); setApiError(false); } } catch (err) {}
  };

  const toggleLiveChat = async () => {
    if (isLiveActive) {
      setIsLiveActive(false);
      setZazaResponding(false);
      if (sessionRef.current) sessionRef.current.close();
      return;
    }
    setIsLiveActive(true);
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    if (!outputAudioContextRef.current) {
      outputAudioContextRef.current = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
    }
    const getCurrentTimeTool: FunctionDeclaration = { name: 'getCurrentTime', description: 'Get current local time.', parameters: { type: Type.OBJECT, properties: {} } };
    const stopReminderTool: FunctionDeclaration = { name: 'stopReminderAction', description: 'Stops reminder.', parameters: { type: Type.OBJECT, properties: {} } };
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        callbacks: {
          onopen: () => {
            const inputCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
            const source = inputCtx.createMediaStreamSource(stream);
            const processor = inputCtx.createScriptProcessor(4096, 1, 1);
            processor.onaudioprocess = (e) => {
              const input = e.inputBuffer.getChannelData(0);
              const int16 = new Int16Array(input.length);
              for(let i=0; i<input.length; i++) int16[i] = input[i] * 32768;
              const pcmData = encode(new Uint8Array(int16.buffer));
              sessionPromise.then(s => s.sendRealtimeInput({ media: { data: pcmData, mimeType: 'audio/pcm;rate=16000' } }));
            };
            source.connect(processor);
            processor.connect(inputCtx.destination);
          },
          onmessage: async (msg: LiveServerMessage) => {
            if (msg.toolCall) {
              const responses = [];
              for (const fc of msg.toolCall.functionCalls) {
                if (fc.name === 'getCurrentTime') {
                  const now = new Date();
                  const timeStr = now.toLocaleTimeString(prefs.language === 'ar' ? 'ar-SA' : 'en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
                  responses.push({ id: fc.id, name: fc.name, response: { result: timeStr } });
                } else if (fc.name === 'stopReminderAction') {
                  const result = stopReminderAction();
                  responses.push({ id: fc.id, name: fc.name, response: { result } });
                }
              }
              if (responses.length > 0) sessionPromise.then(s => s.sendToolResponse({ functionResponses: responses }));
            }
            const audioBase64 = msg.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audioBase64) {
              setZazaResponding(true);
              const buffer = await decodeAudioData(decode(audioBase64), outputAudioContextRef.current!, 24000, 1);
              const source = outputAudioContextRef.current!.createBufferSource();
              source.buffer = buffer;
              source.connect(outputAudioContextRef.current!.destination);
              const playAt = Math.max(nextStartTimeRef.current, outputAudioContextRef.current!.currentTime);
              source.start(playAt);
              nextStartTimeRef.current = playAt + buffer.duration;
              activeSourcesRef.current.add(source);
              source.onended = () => {
                activeSourcesRef.current.delete(source);
                if (activeSourcesRef.current.size === 0) setZazaResponding(false);
              };
            }
          },
          onclose: () => setIsLiveActive(false),
          onerror: () => { setIsLiveActive(false); handleVoiceActivation(); }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          tools: [{ functionDeclarations: [getCurrentTimeTool, stopReminderTool] }],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: prefs.zazaVoice } } },
          systemInstruction: `Your name is Zaza. You are Mohammad's funny assistant. User is: ${prefs.userName || 'User'}.`
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (err) { setIsLiveActive(false); handleVoiceActivation(); }
  };

  const triggerAlarm = useCallback(() => {
    if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
    setStatus(AppStatus.ALARMING);
    setCharState(CharacterState.TAPPING);
    setStartTime(Date.now());
    // Initial alarm play (handled by useEffect but safe to call here)
    audioService.playAlarm(true, prefs.alarmSound);
  }, [prefs.alarmSound]);

  const addReminder = () => {
    if (!newReminderLabel) return;
    const reminder: Reminder = { id: Math.random().toString(36).substr(2, 9), time: newReminderTime, label: newReminderLabel, active: true };
    updatePrefs({ reminders: [...prefs.reminders, reminder] });
    setNewReminderLabel("");
    setShowReminderModal(false);
  };

  const deleteReminder = (id: string) => updatePrefs({ reminders: prefs.reminders.filter(r => r.id !== id) });

  const startNapTimer = (minutes: number) => {
    if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
    setTimerRemaining(minutes * 60);
    setStatus(AppStatus.TIMER_RUNNING);
    setCharState(CharacterState.SLEEPY);
    setShowTimerModal(false);
    timerIntervalRef.current = setInterval(() => {
      setTimerRemaining((prev) => {
        if (prev <= 1) { clearInterval(timerIntervalRef.current!); triggerAlarm(); return 0; }
        return prev - 1;
      });
    }, 1000);
  };

  const handleAwake = () => {
    storageService.saveStat({ bedTime: prefs.targetSleepTime, wakeTime: new Date().toLocaleTimeString(), responseTime: (Date.now() - startTime) / 1000, success: true, date: new Date().toISOString() });
    setStatus(AppStatus.DASHBOARD);
    setCharState(CharacterState.IDLE);
    audioService.playTapping('soft');
  };

  const updatePrefs = (newPrefs: Partial<UserPreferences>) => {
    const updated = { ...prefs, ...newPrefs };
    setPrefs(updated);
    storageService.savePreferences(updated);
  };

  if (status === AppStatus.ONBOARDING) return <Onboarding onComplete={handleOnboardingComplete} />;

  return (
    <div className={`h-full w-full flex flex-col bg-slate-950 overflow-hidden text-white ${prefs.language === 'ar' ? 'rtl font-["Noto_Sans_Arabic"]' : ''}`}>
      <header className="px-5 py-3 flex justify-between items-center z-50 bg-slate-900/40 backdrop-blur-xl border-b border-white/5">
        <div className="flex gap-2">
          <button onClick={() => setShowSettings(true)} className="p-2.5 bg-white/5 rounded-xl border border-white/10 active:scale-90"><Settings className="w-4 h-4 text-indigo-300"/></button>
          <button onClick={() => setShowStats(true)} className="p-2.5 bg-white/5 rounded-xl border border-white/10 active:scale-90"><BarChart2 className="w-4 h-4 text-indigo-300"/></button>
        </div>
        <div className="flex items-center gap-2">
           {apiError && <button onClick={handleVoiceActivation} className="px-3 py-1.5 bg-orange-500/20 text-orange-400 rounded-lg flex items-center gap-1.5 text-[9px] font-black uppercase border border-orange-500/30 animate-pulse"><Sparkles className="w-3.5 h-3.5" /> {t.activateVoice}</button>}
           <button onClick={toggleLiveChat} className={`px-4 py-2 rounded-full flex items-center gap-2 font-black transition-all ${isLiveActive ? 'bg-indigo-600' : 'bg-slate-800'} active:scale-95`}>
            {isLiveActive ? <Mic className={`w-4 h-4 ${zazaResponding ? 'animate-bounce text-white' : 'text-indigo-200'}`}/> : <MicOff className="w-4 h-4 opacity-40"/>}
            <span className="text-[10px] uppercase tracking-tighter">{isLiveActive ? (zazaResponding ? 'Speaking' : 'Listening') : 'Zaza AI'}</span>
          </button>
        </div>
      </header>

      <main className="flex-1 flex flex-col items-center justify-between py-4 px-6 relative overflow-hidden">
        {status === AppStatus.ALARMING ? (
          <div className="w-full h-full relative rounded-[2rem] overflow-hidden border-2 border-indigo-500/30"><CameraVerification onAwake={handleAwake} statusText="Zaza is Checking..." /></div>
        ) : (
          <>
            <div className="text-center z-10 pt-4">
              {status === AppStatus.TIMER_RUNNING ? (
                <div className="animate-pulse"><h2 className="text-6xl font-black text-indigo-400">{Math.floor(timerRemaining/60)}:{(timerRemaining%60).toString().padStart(2, '0')}</h2><p className="text-[10px] uppercase tracking-widest opacity-40">{t.napInProgress}</p></div>
              ) : status === AppStatus.SLEEPING ? (
                <div className="space-y-1"><Moon className="w-6 h-6 mx-auto text-indigo-400 mb-1 animate-pulse" /><h2 className="text-xl font-black uppercase">{t.sleepingNow}</h2><p className="text-[10px] opacity-40">{t.nextAlarm}: {prefs.targetWakeTime}</p></div>
              ) : (
                <div className="space-y-0.5">
                  <h2 className="text-6xl font-light tracking-tighter opacity-90">{currentTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}</h2>
                  {prefs.userName && <p className="text-indigo-400 font-black uppercase tracking-[0.2em] text-[8px]">{prefs.userName}</p>}
                </div>
              )}
            </div>
            
            <div className="flex-1 flex flex-col items-center justify-center w-full max-h-[55%]">
              <ZazaCharacter state={charState} className="scale-[0.8]" />
              <AnimatePresence>
                {status === AppStatus.DASHBOARD && !isReminderFiring && (
                  <motion.button initial={{ scale: 0, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0, opacity: 0 }} onClick={() => setShowReminderModal(true)} className="mt-4 px-6 py-3 bg-white/5 border border-white/10 rounded-full flex items-center gap-2 shadow-lg active:scale-95 transition-all group">
                    <Bell className="w-4 h-4 text-indigo-400 group-hover:animate-swing" /><span className="text-[10px] font-black uppercase tracking-widest">{t.addReminder}</span>
                  </motion.button>
                )}
                {isReminderFiring && (
                  <motion.div initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="mt-4 px-4 py-2 bg-indigo-600/20 border border-indigo-500/40 rounded-xl flex flex-col items-center gap-1 animate-pulse">
                     <span className="text-[9px] font-black uppercase tracking-wider text-indigo-300">Talk to Zaza:</span>
                     <span className="text-[11px] font-bold text-white italic">"حسنا زازا شكرا على التذكير"</span>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <div className="w-full max-w-xs flex flex-col gap-2.5 z-20 mb-6">
              {status === AppStatus.DASHBOARD && (
                <div className="space-y-2.5">
                  <button onClick={() => { setStatus(AppStatus.SLEEPING); setCharState(CharacterState.SLEEPY); audioService.playSleepSound(); }} className="w-full py-4 bg-indigo-600 rounded-[1.5rem] font-black text-base flex flex-col items-center justify-center shadow-lg active:scale-95 transition-all"><Moon className="w-5 h-5 mb-0.5" /> <span>{t.startSleep}</span></button>
                  <div className="grid grid-cols-2 gap-2.5">
                    <button onClick={() => setShowTimerModal(true)} className="py-3.5 bg-white/5 border border-white/10 rounded-[1.2rem] font-bold text-xs flex items-center justify-center gap-2 active:scale-95"><Coffee className="w-4 h-4 text-orange-400" /> {t.napTimer}</button>
                    <button onClick={() => setShowReminderModal(true)} className="py-3.5 bg-white/5 border border-white/10 rounded-[1.2rem] font-bold text-xs flex items-center justify-center gap-2 active:scale-95"><PlusCircle className="w-4 h-4 text-indigo-400" /> {t.addTimer}</button>
                  </div>
                </div>
              )}
              {status === AppStatus.SLEEPING && <button onClick={() => { setStatus(AppStatus.DASHBOARD); setCharState(CharacterState.IDLE); }} className="w-full py-4 bg-white/5 border border-white/10 rounded-2xl font-black text-[10px] text-white/30 uppercase tracking-widest">Wake Up Manually</button>}
            </div>
          </>
        )}
      </main>

      <AnimatePresence>
        {showReminderModal && (
          <motion.div initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} className="fixed inset-0 z-[120] bg-slate-950/98 backdrop-blur-2xl flex items-center justify-center p-6">
            <div className="w-full max-w-sm space-y-6">
              <div className="flex justify-between items-center"><h2 className="text-2xl font-black">{t.reminders}</h2><button onClick={() => setShowReminderModal(false)} className="p-2 bg-white/10 rounded-full"><X className="w-5 h-5"/></button></div>
              <div className="bg-white/5 p-5 rounded-[2rem] border border-white/10 space-y-4">
                 <div className="space-y-2"><label className="text-[10px] font-black uppercase text-indigo-400">{t.reminderTime}</label><input type="time" value={newReminderTime} onChange={(e) => setNewReminderTime(e.target.value)} className="w-full p-4 bg-white/5 rounded-2xl text-2xl font-black text-center outline-none border border-white/5 focus:border-indigo-500" /></div>
                 <div className="space-y-2"><label className="text-[10px] font-black uppercase text-indigo-400">{t.reminderLabel}</label><div className="flex flex-wrap gap-2 mb-2">{[t.studyTime, t.gymTime, t.workTime].map(label => (<button key={label} onClick={() => setNewReminderLabel(label)} className={`px-3 py-1.5 rounded-full text-[10px] font-bold transition-all ${newReminderLabel === label ? 'bg-indigo-600' : 'bg-white/5 border border-white/10'}`}>{label}</button>))}</div><input type="text" value={newReminderLabel} onChange={(e) => setNewReminderLabel(e.target.value)} placeholder="..." className="w-full p-4 bg-white/5 rounded-2xl text-lg font-black outline-none border border-white/5 focus:border-indigo-500" /></div>
                 <button onClick={addReminder} className="w-full py-4 bg-indigo-600 rounded-2xl font-black text-lg shadow-xl shadow-indigo-900/40">{t.save}</button>
              </div>
              <div className="max-h-[30vh] overflow-y-auto space-y-2 pr-2">{prefs.reminders.length === 0 ? (<p className="text-center opacity-20 text-xs py-4 uppercase tracking-widest">{t.noReminders}</p>) : (prefs.reminders.map(r => (<div key={r.id} className="p-4 bg-white/5 rounded-2xl border border-white/5 flex justify-between items-center group"><div><p className="text-lg font-black text-indigo-400">{r.time}</p><p className="text-[10px] font-bold opacity-60 uppercase">{r.label}</p></div><button onClick={() => deleteReminder(r.id)} className="p-2 text-red-500/30 hover:text-red-500 hover:bg-red-500/10 rounded-xl transition-all"><Trash2 className="w-4 h-4" /></button></div>)))}</div>
            </div>
          </motion.div>
        )}
        {showTimerModal && (
          <motion.div initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} className="fixed inset-0 z-[100] bg-slate-950/95 backdrop-blur-xl flex items-center justify-center p-6">
            <div className="w-full max-w-sm space-y-8">
              <div className="text-center"><Timer className="w-12 h-12 mx-auto text-indigo-400 mb-2"/><h2 className="text-3xl font-black">{t.napTimer}</h2></div>
              <div className="flex items-center gap-4 bg-white/5 p-4 rounded-2xl border border-white/10"><input type="number" value={customTimerValue} onChange={(e) => setCustomTimerValue(e.target.value)} className="flex-1 bg-transparent text-4xl font-black text-center outline-none text-indigo-400"/><span className="text-lg font-bold opacity-30 mr-2">MIN</span></div>
              <div className="grid grid-cols-3 gap-2">{[15, 30, 45, 60].map(m => (<button key={m} onClick={() => setCustomTimerValue(m.toString())} className={`py-3 rounded-xl font-bold text-sm ${customTimerValue === m.toString() ? 'bg-indigo-600' : 'bg-white/5'}`}>{m}m</button>))}</div>
              <div className="space-y-3"><button onClick={() => startNapTimer(parseInt(customTimerValue))} className="w-full py-5 bg-indigo-600 rounded-2xl font-black text-xl">Start</button><button onClick={() => setShowTimerModal(false)} className="w-full py-3 text-white/20 font-bold text-xs uppercase text-center">Close</button></div>
            </div>
          </motion.div>
        )}
        {showSettings && (
          <motion.div initial={{y:'100%'}} animate={{y:0}} exit={{y:'100%'}} className="fixed inset-0 z-[110] bg-slate-950 p-6 flex flex-col overflow-y-auto">
            <div className="flex justify-between items-center mb-8"><h2 className="text-2xl font-black">{t.settings}</h2><button onClick={() => setShowSettings(false)} className="p-2 bg-white/10 rounded-full"><X/></button></div>
            <div className="space-y-6 pb-20">
               <button onClick={() => { setShowSettings(false); triggerAlarm(); }} className="w-full py-4 bg-indigo-600 text-white rounded-2xl font-black flex items-center justify-center gap-2 active:scale-95 shadow-lg shadow-indigo-900/50"><Play className="w-4 h-4" /> {t.testAlarm}</button>
               <div className={`p-5 rounded-3xl border-2 transition-all ${apiError ? 'bg-orange-500/5 border-orange-500/20' : 'bg-green-500/5 border-green-500/20'}`}><div className="flex items-start gap-4"><div className={`p-3 rounded-2xl ${apiError ? 'bg-orange-500/20 text-orange-400' : 'bg-green-500/20 text-green-400'}`}>{apiError ? <AlertCircle className="w-6 h-6" /> : <Sparkles className="w-6 h-6" />}</div><div className="flex-1 space-y-1"><h3 className="font-black text-sm uppercase tracking-widest">{apiError ? t.voiceRequired : t.voiceReady}</h3><p className="text-[10px] leading-relaxed opacity-60">{t.voiceDesc}</p></div></div>{apiError && <button onClick={handleVoiceActivation} className="w-full mt-4 py-3 bg-indigo-600 rounded-xl font-black text-xs uppercase shadow-md active:scale-95 transition-all">{t.activateVoice}</button>}<a href="https://ai.google.dev/gemini-api/docs/billing" target="_blank" className="flex items-center justify-center gap-1.5 mt-3 text-[8px] font-bold opacity-30 uppercase">{t.billingLink} <ExternalLink className="w-2 h-2" /></a></div>
               <div className="grid grid-cols-2 gap-4"><div className="space-y-2"><label className="text-[10px] font-black uppercase text-indigo-400 flex items-center gap-1.5"><Moon className="w-3 h-3" /> {t.bedTime}</label><input type="time" value={prefs.targetSleepTime} onChange={e => updatePrefs({ targetSleepTime: e.target.value })} className="w-full p-4 bg-white/5 border border-white/10 rounded-2xl text-xl font-black text-center outline-none focus:border-indigo-500"/></div><div className="space-y-2"><label className="text-[10px] font-black uppercase text-orange-400 flex items-center gap-1.5"><Sun className="w-3 h-3" /> {t.wakeUpTime}</label><input type="time" value={prefs.targetWakeTime} onChange={e => updatePrefs({ targetWakeTime: e.target.value })} className="w-full p-4 bg-white/5 border border-white/10 rounded-2xl text-xl font-black text-center outline-none focus:border-orange-500"/></div></div>
               <div className="space-y-3"><label className="text-[10px] font-black uppercase tracking-widest text-indigo-300 flex items-center gap-2"><Volume2 className="w-3.5 h-3.5" /> {t.alarmSound}</label><div className="grid grid-cols-3 gap-2">{(['Classic', 'Bell', 'Digital'] as AlarmSoundType[]).map((snd) => (<button key={snd} onClick={() => { updatePrefs({ alarmSound: snd }); audioService.playAlarm(false, snd); }} className={`py-3 rounded-xl font-bold text-[10px] transition-all ${prefs.alarmSound === snd ? 'bg-indigo-600 border-indigo-400' : 'bg-white/5 border-white/10'} border`}>{snd}</button>))}</div></div>
               <div className="space-y-3"><div className="flex justify-between items-center"><label className="text-[10px] font-black uppercase tracking-widest text-indigo-300 flex items-center gap-2"><UserCheck className="w-3.5 h-3.5" /> {t.zazaVoice}</label>{isPreviewingVoice && <Loader2 className="w-3 h-3 animate-spin text-indigo-400" />}</div><div className="grid grid-cols-5 gap-1.5">{(['Puck', 'Charon', 'Kore', 'Fenrir', 'Zephyr'] as ZazaVoiceType[]).map((v) => (<button key={v} onClick={() => { updatePrefs({ zazaVoice: v }); previewZazaVoice(v); }} className={`py-2 rounded-lg font-black text-[9px] transition-all ${prefs.zazaVoice === v ? 'bg-indigo-600 text-white' : 'bg-white/5 text-white/40'}`} disabled={isPreviewingVoice}>{v}</button>))}</div></div>
               <div className="pt-4 space-y-3"><button onClick={() => updatePrefs({ language: prefs.language === 'en' ? 'ar' : 'en' })} className="w-full py-4 bg-white/5 border border-white/10 rounded-2xl font-black text-sm flex items-center justify-center gap-2">{t.languageToggle}</button><button onClick={() => { localStorage.clear(); window.location.reload(); }} className="w-full py-3 text-red-500/30 font-black text-[10px] uppercase tracking-widest">Reset Application Data</button></div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default App;
