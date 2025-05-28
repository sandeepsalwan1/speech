"use client"

import { useState, useEffect, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

export default function VoiceBrowserUI() {
  const [isConnected, setIsConnected] = useState(false)
  const [isListening, setIsListening] = useState(false)
  const [transcript, setTranscript] = useState("")
  const [messages, setMessages] = useState<Array<{type: string, text: string, timestamp: number}>>([])
  const [isProcessing, setIsProcessing] = useState(false)
  const [isSpeaking, setIsSpeaking] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const recognitionRef = useRef<any>(null)
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const reconnectAttemptsRef = useRef(0)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const currentUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null)
  const [availableVoices, setAvailableVoices] = useState<SpeechSynthesisVoice[]>([])
  const [selectedVoiceIndex, setSelectedVoiceIndex] = useState<number>(0)
  const [speechEnabled, setSpeechEnabled] = useState(false)
  
  // Message deduplication
  const processedMessagesRef = useRef<Set<string>>(new Set())
  const lastResultMessageRef = useRef<string>('')

  // Initialize speech synthesis
  const initializeSpeech = () => {
    if ('speechSynthesis' in window) {
      console.log('Speech synthesis available')
      setSpeechEnabled(true)
      
      // Test speech synthesis capability
      const testUtterance = new SpeechSynthesisUtterance('')
      testUtterance.volume = 0  // Silent test
      window.speechSynthesis.speak(testUtterance)
      
      return true
    } else {
      console.error('Speech synthesis not available')
      setSpeechEnabled(false)
      return false
    }
  }

  // Load available voices and initialize speech
  useEffect(() => {
    // Initialize speech synthesis first
    initializeSpeech()
    
    const loadVoices = () => {
      if ('speechSynthesis' in window) {
        const voices = window.speechSynthesis.getVoices()
        console.log('Available voices:', voices)
        if (voices.length > 0) {
          setAvailableVoices(voices)
          // Find and set a good default voice
          const preferredIndex = voices.findIndex(voice => 
            voice.name.includes('Samantha') || 
            voice.name.includes('Victoria') || 
            voice.name.includes('Karen') ||
            voice.name.includes('Female') ||
            voice.name.includes('Google US English') ||
            voice.name.includes('Microsoft Zira') ||
            voice.name.includes('Alex') ||
            voice.default
          )
          if (preferredIndex !== -1) {
            setSelectedVoiceIndex(preferredIndex)
            console.log('Selected voice:', voices[preferredIndex])
          }
        }
      }
    }

    // Load voices immediately and on change
    loadVoices()
    if ('speechSynthesis' in window) {
      window.speechSynthesis.onvoiceschanged = loadVoices
    }

    // Also try loading after a delay (some browsers need this)
    setTimeout(loadVoices, 1000)
  }, [])

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  // Keyboard shortcuts for accessibility
  useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      // Space bar to toggle listening (when not typing in an input)
      if (e.code === 'Space' && e.target === document.body) {
        e.preventDefault()
        toggleListening()
      }
      // Escape to interrupt speech
      else if (e.code === 'Escape') {
        e.preventDefault()
        if (isSpeaking) {
          interruptSpeech()
        } else if (isProcessing) {
          cancelCurrentTask()
        }
      }
      // C to cancel current task
      else if (e.code === 'KeyC' && e.ctrlKey && isProcessing) {
        e.preventDefault()
        cancelCurrentTask()
      }
    }

    document.addEventListener('keydown', handleKeyPress)
    return () => document.removeEventListener('keydown', handleKeyPress)
  }, [isListening, isSpeaking, isProcessing, isConnected])

  // Connect to backend WebSocket
  useEffect(() => {
    connectToBackend()
    setupSpeechRecognition()
    
    return () => {
      // Clean up on unmount
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
      }
      if (wsRef.current) {
        wsRef.current.close()
      }
      if (recognitionRef.current) {
        recognitionRef.current.stop()
      }
      // Cancel any ongoing speech
      if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel()
      }
    }
  }, [])

  const connectToBackend = () => {
    try {
      // Clear any existing connection
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.close()
      }

      // const ws = new WebSocket('ws://localhost:8001/ws')
      const wsUrl = process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:8000/ws'
      const ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = () => {
        setIsConnected(true)
        reconnectAttemptsRef.current = 0
        addMessage('system', 'Connected to voice browser backend')
        // Announce connection for screen readers - use a delay to ensure speech works
        setTimeout(() => {
          speak('Connected to voice browser. You can now give commands.', true)
        }, 500)
      }

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          console.log('📨 Received WebSocket message:', data.type, data.data)
          
          // Create a unique message ID for deduplication
          const messageId = `${data.type}-${JSON.stringify(data.data)}-${Date.now()}`
          const messageHash = `${data.type}-${JSON.stringify(data.data)}`
          
          // Check for duplicate messages (same type and content within 2 seconds)
          const now = Date.now()
          const messageWithTime = `${messageHash}-${Math.floor(now / 2000)}` // 2-second window
          
          if (processedMessagesRef.current.has(messageWithTime)) {
            console.log('🔄 Duplicate message detected within time window, skipping:', data.type)
            return
          }
          
          // Add to processed messages (keep only last 50 to prevent memory leak)
          processedMessagesRef.current.add(messageWithTime)
          if (processedMessagesRef.current.size > 50) {
            const firstItem = Array.from(processedMessagesRef.current)[0]
            if (firstItem) {
              processedMessagesRef.current.delete(firstItem)
            }
          }
          
          if (data.type === 'speak') {
            console.log('🔊 Processing speak message:', data.data.text.substring(0, 50) + '...')
            // Always read aloud assistant responses for accessibility
            speak(data.data.text, false, true)
            addMessage('assistant', data.data.text)
          } else if (data.type === 'result') {
            console.log('📋 Processing result message:', data.data.text.substring(0, 50) + '...')
            
            // Additional check for result message deduplication
            if (lastResultMessageRef.current === data.data.text) {
              console.log('🔄 Duplicate result message detected, skipping speech')
              addMessage('result', data.data.text)
              return
            }
            lastResultMessageRef.current = data.data.text
            
            // Read results aloud with higher priority
            speak(data.data.text, false, true)
            addMessage('result', data.data.text)
          } else if (data.type === 'status') {
            console.log('📊 Processing status message:', data.data.message)
            addMessage('status', data.data.message)
            if (data.data.message.includes('Processing:')) {
              setIsProcessing(true)
            } else if (data.data.message.includes('Ready')) {
              setIsProcessing(false)
            }
          } else if (data.type === 'error') {
            console.log('❌ Processing error message:', data.data.message)
            addMessage('error', data.data.message)
            speak(`Error: ${data.data.message}`, true)
            setIsProcessing(false)
          }
        } catch (error) {
          console.error('Error parsing WebSocket message:', error)
        }
      }

      ws.onclose = (event) => {
        setIsConnected(false)
        addMessage('system', 'Disconnected from backend')
        
        // Only announce and retry if it wasn't a clean close
        if (event.code !== 1000) {
          speak('Disconnected from voice browser backend', true)
          
          // Exponential backoff for reconnection
          const delay = Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current), 30000)
          reconnectAttemptsRef.current++
          
          addMessage('system', `Attempting to reconnect in ${delay/1000} seconds...`)
          
          reconnectTimeoutRef.current = setTimeout(() => {
            connectToBackend()
          }, delay)
        }
      }

      ws.onerror = (error) => {
        console.error('WebSocket error:', error)
        addMessage('error', 'Connection error. Please check if backend is running on port 8000.')
      }

    } catch (error) {
      console.error('Failed to connect to backend:', error)
      addMessage('error', 'Failed to connect to backend. Please ensure the backend is running with: python -m uvicorn voice_browser_server:app --host 0.0.0.0 --port 8000')
    }
  }

  const setupSpeechRecognition = () => {
    if (typeof window !== 'undefined' && 'webkitSpeechRecognition' in window) {
      const recognition = new (window as any).webkitSpeechRecognition()
      recognition.continuous = true
      recognition.interimResults = true
      recognition.lang = 'en-US'
      
      recognition.onresult = (event: any) => {
        const current = event.resultIndex
        const transcript = event.results[current][0].transcript
        
        setTranscript(transcript)
        
        // Check for interruption commands while speaking
        if (isSpeaking && transcript.toLowerCase().includes('stop')) {
          interruptSpeech()
        }
        
        // Check for final result
        if (event.results[current].isFinal) {
          const finalTranscript = transcript.trim()
          
          if (finalTranscript) {
            // Send command to backend
            sendCommand(finalTranscript)
            addMessage('user', finalTranscript)
          }
          
          setTranscript('')
        }
      }
      
      recognition.onerror = (event: any) => {
        console.error('Speech recognition error:', event.error)
        addMessage('error', `Speech recognition error: ${event.error}`)
        setIsListening(false)
      }
      
      recognition.onend = () => {
        if (isListening && isConnected) {
          // Restart recognition if it was supposed to be listening
          recognition.start()
        }
      }
      
      recognitionRef.current = recognition
    } else {
      addMessage('error', 'Speech recognition not supported in this browser')
    }
  }

  const speak = (text: string, isSystem: boolean = false, priority: boolean = false) => {
    console.log('🎤 Speak function called:', {
      text: text.substring(0, 50) + (text.length > 50 ? '...' : ''),
      isSystem,
      priority,
      currentlySpeaking: isSpeaking,
      speechSynthesisSupported: 'speechSynthesis' in window,
      availableVoicesCount: availableVoices.length,
      selectedVoiceIndex: selectedVoiceIndex
    })
    
    if (!('speechSynthesis' in window)) {
      console.error('❌ Speech synthesis not supported')
      return
    }

    // Cancel current speech if this is a priority message or interruption
    if (priority || (isSpeaking && !isSystem)) {
      console.log('🛑 Cancelling previous speech for new message')
      window.speechSynthesis.cancel()
      setIsSpeaking(false)
      currentUtteranceRef.current = null
      
      // Wait a bit for cancellation to complete
      setTimeout(() => {
        startSpeech(text, isSystem, priority)
      }, 100)
      return
    }
    
    // If already speaking and this is not a priority message, skip
    if (isSpeaking && !priority) {
      console.log('⏭️ Skipping speech - already speaking and not priority')
      return
    }
    
    startSpeech(text, isSystem, priority)
  }
  
  const startSpeech = (text: string, isSystem: boolean = false, priority: boolean = false) => {
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.rate = 0.8  // Slightly slower for better clarity
    utterance.pitch = 1
    utterance.volume = 1
    
    // Ensure we have voices loaded
    if (availableVoices.length === 0) {
      console.log('🔄 No voices loaded yet, loading voices...')
      const voices = window.speechSynthesis.getVoices()
      if (voices.length > 0) {
        setAvailableVoices(voices)
        // Find a good default voice
        const preferredIndex = voices.findIndex(voice => 
          voice.name.includes('Samantha') || 
          voice.name.includes('Victoria') || 
          voice.name.includes('Karen') ||
          voice.name.includes('Female') ||
          voice.name.includes('Google US English') ||
          voice.name.includes('Microsoft Zira') ||
          voice.name.includes('Alex') ||
          voice.default
        )
        if (preferredIndex !== -1) {
          setSelectedVoiceIndex(preferredIndex)
          utterance.voice = voices[preferredIndex]
          console.log('🗣️ Auto-selected voice:', voices[preferredIndex].name)
        }
      }
    } else {
      // Set selected voice
      if (selectedVoiceIndex < availableVoices.length) {
        utterance.voice = availableVoices[selectedVoiceIndex]
        console.log('🗣️ Using voice:', utterance.voice?.name)
      } else {
        console.log('🗣️ Invalid voice index, using default')
      }
    }
    
    utterance.onstart = () => {
      console.log('▶️ Speech started:', text.substring(0, 30) + '...')
      setIsSpeaking(true)
      currentUtteranceRef.current = utterance
    }
    
    utterance.onend = () => {
      console.log('⏹️ Speech ended')
      setIsSpeaking(false)
      currentUtteranceRef.current = null
    }
    
    utterance.onerror = (event) => {
      console.error('❌ Speech error:', event)
      setIsSpeaking(false)
      currentUtteranceRef.current = null
      
      // Try again with a different approach if it's a network error
      if (event.error === 'network' || event.error === 'synthesis-failed') {
        console.log('🔄 Retrying speech with simpler settings...')
        setTimeout(() => {
          const retryUtterance = new SpeechSynthesisUtterance(text)
          retryUtterance.rate = 1
          retryUtterance.pitch = 1
          retryUtterance.volume = 1
          // Don't set a specific voice for retry
          window.speechSynthesis.speak(retryUtterance)
        }, 500)
      }
    }
    
    // For Safari and other browsers that may need this
    utterance.onboundary = (event) => {
      console.log('📍 Speech boundary:', event.name)
    }
    
    try {
      console.log('🚀 Starting speech synthesis')
      window.speechSynthesis.speak(utterance)
      
    } catch (error) {
      console.error('❌ Error starting speech:', error)
      setIsSpeaking(false)
    }
  }

  const interruptSpeech = () => {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel()
      setIsSpeaking(false)
      currentUtteranceRef.current = null
      
      // Send interrupt command to backend
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ 
          type: 'interrupt', 
          text: '' 
        }))
      }
    }
  }

  const sendCommand = (command: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ 
        type: 'command', 
        text: command 
      }))
    } else {
      addMessage('error', 'Not connected to backend')
    }
  }

  const addMessage = (type: string, text: string) => {
    setMessages(prev => [...prev, { 
      type, 
      text, 
      timestamp: Date.now() 
    }])
  }

  const toggleListening = () => {
    if (!recognitionRef.current) {
      speak('Speech recognition not available', true)
      return
    }

    if (!isConnected) {
      speak('Not connected to backend', true)
      return
    }

    if (isListening) {
      recognitionRef.current.stop()
      setIsListening(false)
      speak('Stopped listening', true)
    } else {
      try {
        recognitionRef.current.start()
        setIsListening(true)
        speak('Started listening for commands', true)
      } catch (error) {
        console.error('Failed to start recognition:', error)
        speak('Failed to start listening', true)
      }
    }
  }

  const cancelCurrentTask = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ 
        type: 'cancel', 
        text: '' 
      }))
      speak('Cancelling current task', true)
    }
  }

  // Get latest message for screen readers
  const latestMessage = messages.length > 0 ? messages[messages.length - 1] : null

  return (
    <div className="min-h-screen bg-gray-50 p-4">
      <div className="max-w-4xl mx-auto">
        <main role="main" aria-live="polite">
          <Card>
            <CardHeader>
              <CardTitle>
                Voice Browser Control
                <span className="sr-only">
                  {isConnected ? 'Connected to backend' : 'Disconnected from backend'}
                </span>
              </CardTitle>
              <div className="flex items-center gap-2">
                <div 
                  className={`w-3 h-3 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`}
                  aria-hidden="true"
                />
                <span>{isConnected ? 'Connected' : 'Disconnected'}</span>
                {!isConnected && (
                  <Button
                    onClick={connectToBackend}
                    size="sm"
                    variant="outline"
                  >
                    Retry Connection
                  </Button>
                )}
              </div>
            </CardHeader>
            
            <CardContent className="space-y-4">
              {/* Main Control Buttons */}
              <div className="flex gap-4 flex-wrap">
                <Button
                  onClick={toggleListening}
                  disabled={!isConnected}
                  className={`${isListening ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'} text-white px-6 py-3 text-lg`}
                  aria-describedby="listening-status"
                >
                  {isListening ? 'Stop Listening' : 'Start Listening'}
                </Button>
                
                {isProcessing && (
                  <Button
                    onClick={cancelCurrentTask}
                    className="bg-orange-600 hover:bg-orange-700 text-white px-6 py-3 text-lg"
                  >
                    Cancel Task
                  </Button>
                )}
                
                {isSpeaking && (
                  <Button
                    onClick={interruptSpeech}
                    className="bg-purple-600 hover:bg-purple-700 text-white px-6 py-3 text-lg"
                    aria-label="Stop speaking"
                  >
                    Stop Speaking
                  </Button>
                )}
              </div>

              <div id="listening-status" className="sr-only">
                {isListening ? 'Currently listening for voice commands' : 'Not listening'}
                {transcript && `, current transcript: ${transcript}`}
                {isSpeaking && ', Currently speaking'}
              </div>

              {/* Current Transcript */}
              {transcript && (
                <div className="p-4 bg-blue-50 border border-blue-200 rounded">
                  <p><strong>Hearing:</strong> {transcript}</p>
                </div>
              )}

              {/* Speaking indicator */}
              {isSpeaking && (
                <div className="p-4 bg-purple-50 border border-purple-200 rounded flex items-center gap-2">
                  <div className="animate-pulse">
                    <svg className="w-5 h-5 text-purple-600" fill="currentColor" viewBox="0 0 20 20">
                      <path d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-6-3a2 2 0 11-4 0 2 2 0 014 0zm-2 4a5 5 0 00-4.546 2.916A5.986 5.986 0 0010 16a5.986 5.986 0 004.546-2.084A5 5 0 0010 11z" />
                    </svg>
                  </div>
                  <p><strong>Speaking...</strong> (Say "stop" to interrupt)</p>
                </div>
              )}

              {/* Status Messages - Fixed scrolling container */}
              <div className="border rounded-lg bg-white" style={{ height: '400px' }}>
                <div className="p-2 border-b bg-gray-50">
                  <h3 className="font-semibold">Chat History</h3>
                </div>
                <div className="overflow-y-auto" style={{ height: 'calc(100% - 40px)' }}>
                  <div className="p-4 space-y-2">
                    {messages.map((msg, idx) => (
                      <div
                        key={`${msg.timestamp}-${idx}`}
                        className={`p-3 rounded ${
                          msg.type === 'user' ? 'bg-blue-100 border-l-4 border-blue-500' :
                          msg.type === 'assistant' ? 'bg-green-100 border-l-4 border-green-500' :
                          msg.type === 'result' ? 'bg-indigo-100 border-l-4 border-indigo-500' :
                          msg.type === 'error' ? 'bg-red-100 border-l-4 border-red-500' :
                          msg.type === 'system' ? 'bg-gray-100 border-l-4 border-gray-500' :
                          'bg-yellow-100 border-l-4 border-yellow-500'
                        }`}
                        role={msg.type === 'error' ? 'alert' : undefined}
                      >
                        <p>
                          <strong className="capitalize">{msg.type}:</strong> {msg.text}
                        </p>
                      </div>
                    ))}
                    <div ref={messagesEndRef} />
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Settings Card */}
          <Card className="mt-6">
            <CardHeader>
              <CardTitle>Voice Settings</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div>
                  <label htmlFor="voice-select" className="block text-sm font-medium mb-2">
                    Text-to-Speech Voice
                  </label>
                  <select
                    id="voice-select"
                    value={selectedVoiceIndex}
                    onChange={(e) => setSelectedVoiceIndex(Number(e.target.value))}
                    className="w-full p-2 border rounded-md"
                    aria-label="Select text-to-speech voice"
                  >
                    {availableVoices.map((voice, index) => (
                      <option key={index} value={index}>
                        {voice.name} ({voice.lang})
                      </option>
                    ))}
                  </select>
                </div>
                <Button
                  onClick={() => speak('This is a test of the selected voice.', true)}
                  variant="outline"
                  size="sm"
                >
                  Test Voice
                </Button>
                <Button
                  onClick={() => {
                    console.log('Manual test button clicked')
                    // Force enable speech synthesis first
                    if ('speechSynthesis' in window) {
                      // Try a simple test first
                      const testUtterance = new SpeechSynthesisUtterance('Hello')
                      testUtterance.rate = 0.8
                      testUtterance.volume = 1
                      testUtterance.onstart = () => console.log('Manual test started')
                      testUtterance.onend = () => console.log('Manual test ended')
                      testUtterance.onerror = (e) => console.error('Manual test error:', e)
                      window.speechSynthesis.speak(testUtterance)
                    }
                  }}
                  variant="outline"
                  size="sm"
                  className="ml-2"
                >
                  Manual Test
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Instructions */}
          <Card className="mt-6">
            <CardHeader>
              <CardTitle>Voice Browser for Accessibility</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div>
                  <h4 className="font-semibold mb-2">Voice Commands:</h4>
                  <ul className="space-y-1 text-sm">
                    <li>• Say commands like "Search for Python tutorials" or "Go to Google"</li>
                    <li>• Say "Stop" while the assistant is speaking to interrupt</li>
                    <li>• Say "Cancel" to stop the current task</li>
                    <li>• All results will be read aloud automatically</li>
                  </ul>
                </div>
                
                <div>
                  <h4 className="font-semibold mb-2">Keyboard Shortcuts:</h4>
                  <ul className="space-y-1 text-sm">
                    <li>• <kbd>Space</kbd> - Start/Stop listening</li>
                    <li>• <kbd>Escape</kbd> - Interrupt speech or cancel task</li>
                    <li>• <kbd>Ctrl+C</kbd> - Cancel current task</li>
                  </ul>
                </div>
                
                <div>
                  <h4 className="font-semibold mb-2">Features:</h4>
                  <ul className="space-y-1 text-sm">
                    <li>• The chat history preserves all interactions and can be scrolled</li>
                    <li>• Designed for screen readers and keyboard navigation</li>
                    <li>• Customizable text-to-speech voice</li>
                    <li>• Visual and audio feedback for all actions</li>
                  </ul>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Hidden live region for screen reader announcements */}
          <div aria-live="assertive" aria-atomic="true" className="sr-only">
            {latestMessage && (latestMessage.type === 'assistant' || latestMessage.type === 'result') && latestMessage.text}
          </div>
        </main>
      </div>
    </div>
  )
} 