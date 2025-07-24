const express = require('express');
const twilio = require('twilio');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// In-memory storage for demo (use database in production)
let callLogs = [];
let activeCall = null;

// Twilio configuration
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = twilio(accountSid, authToken);

// Call states for flow management
const CALL_STATES = {
  GREETING: 'greeting',
  ASKING_NAME: 'asking_name',
  ASKING_AGE: 'asking_age',
  ASKING_ISSUE: 'asking_issue',
  ROUTING: 'routing',
  COMPLETED: 'completed'
};

// AI Call Handler
class AICallHandler {
  constructor() {
    this.callData = {};
  }

  processCall(callSid, userInput = '', currentState = CALL_STATES.GREETING) {
    if (!this.callData[callSid]) {
      this.callData[callSid] = {
        sid: callSid,
        startTime: new Date().toISOString(),
        state: CALL_STATES.GREETING,
        responses: {},
        transcript: []
      };
    }

    const call = this.callData[callSid];
    let response = '';
    let nextState = currentState;

    switch (currentState) {
      case CALL_STATES.GREETING:
        response = "Hello! Welcome to AI Customer Service. I'm your virtual assistant. May I have your full name please?";
        nextState = CALL_STATES.ASKING_NAME;
        break;

      case CALL_STATES.ASKING_NAME:
        if (userInput.trim()) {
          call.responses.name = userInput.trim();
          response = `Thank you ${call.responses.name}. May I have your age please?`;
          nextState = CALL_STATES.ASKING_AGE;
        } else {
          response = "I didn't catch that. Could you please tell me your full name?";
        }
        break;

      case CALL_STATES.ASKING_AGE:
        if (userInput.trim() && !isNaN(userInput.trim())) {
          call.responses.age = parseInt(userInput.trim());
          response = "Great! Now, could you briefly describe the reason for your call today?";
          nextState = CALL_STATES.ASKING_ISSUE;
        } else {
          response = "Please provide your age as a number.";
        }
        break;

      case CALL_STATES.ASKING_ISSUE:
        if (userInput.trim()) {
          call.responses.issue = userInput.trim();
          response = `Thank you for that information, ${call.responses.name}. Based on your inquiry about "${call.responses.issue}", I'm now connecting you to one of our human agents who can better assist you. Please hold on.`;
          nextState = CALL_STATES.ROUTING;
        } else {
          response = "Could you please describe the reason for your call?";
        }
        break;

      case CALL_STATES.ROUTING:
        response = "You are being transferred to a human agent. Thank you for your patience.";
        nextState = CALL_STATES.COMPLETED;
        this.logCall(call);
        break;
    }

    call.state = nextState;
    call.transcript.push({
      timestamp: new Date().toISOString(),
      type: userInput ? 'user' : 'ai',
      message: userInput || response
    });

    return { response, nextState, callData: call };
  }

  logCall(call) {
    const logEntry = {
      ...call,
      endTime: new Date().toISOString(),
      duration: Math.round((new Date() - new Date(call.startTime)) / 1000),
      status: 'completed'
    };
    
    callLogs.push(logEntry);
    activeCall = null;
  }
}

const aiHandler = new AICallHandler();

// Twilio webhook endpoint for incoming calls
app.post('/webhook/voice', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const callSid = req.body.CallSid;
  
  // Start the call flow
  const result = aiHandler.processCall(callSid);
  activeCall = result.callData;
  
  // Use Twilio's Gather to collect speech input
  const gather = twiml.gather({
    input: 'speech',
    timeout: 10,
    speechTimeout: 'auto',
    action: '/webhook/gather',
    method: 'POST'
  });
  
  gather.say({
    voice: 'alice'
  }, result.response);

  // Fallback if no input
  twiml.say({
    voice: 'alice'
  }, "I didn't hear anything. Please call back.");

  res.type('text/xml');
  res.send(twiml.toString());
});

// Handle user responses
app.post('/webhook/gather', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const callSid = req.body.CallSid;
  const userInput = req.body.SpeechResult || '';
  const currentCall = aiHandler.callData[callSid];
  
  if (!currentCall) {
    twiml.say('Sorry, there was an error. Please call back.');
    res.type('text/xml');
    res.send(twiml.toString());
    return;
  }

  const result = aiHandler.processCall(callSid, userInput, currentCall.state);
  
  if (result.nextState === CALL_STATES.ROUTING) {
    // Simulate routing to human agent
    twiml.say({
      voice: 'alice'
    }, result.response);
    
    // In a real scenario, you would dial a human agent number
    // twiml.dial('+1234567890'); // Replace with actual agent number
    
    // For demo, we'll just play hold music and end
    twiml.play('http://com.twilio.music.guitars.s3.amazonaws.com/pitangui_guitars_01.mp3');
    twiml.say({
      voice: 'alice'
    }, 'Thank you for calling. This demo call is now ending.');
    
  } else if (result.nextState === CALL_STATES.COMPLETED) {
    twiml.say({
      voice: 'alice'
    }, result.response);
    twiml.hangup();
    
  } else {
    // Continue the conversation
    const gather = twiml.gather({
      input: 'speech',
      timeout: 10,
      speechTimeout: 'auto',
      action: '/webhook/gather',
      method: 'POST'
    });
    
    gather.say({
      voice: 'alice'
    }, result.response);
    
    twiml.say({
      voice: 'alice'
    }, "I didn't hear a response. Please try again or call back.");
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

// API endpoints for dashboard
app.get('/api/calls', (req, res) => {
  res.json({
    calls: callLogs,
    activeCall: activeCall,
    stats: {
      totalCalls: callLogs.length,
      avgDuration: callLogs.length > 0 ? Math.round(callLogs.reduce((sum, call) => sum + (call.duration || 0), 0) / callLogs.length) : 0,
      completedCalls: callLogs.filter(call => call.status === 'completed').length
    }
  });
});

app.get('/api/call/:sid', (req, res) => {
  const call = callLogs.find(c => c.sid === req.params.sid) || aiHandler.callData[req.params.sid];
  if (call) {
    res.json(call);
  } else {
    res.status(404).json({ error: 'Call not found' });
  }
});

// Agent status endpoint (simulated)
app.get('/api/agents', (req, res) => {
  const agents = [
    { id: 1, name: 'John Smith', status: 'available', currentCall: null },
    { id: 2, name: 'Sarah Johnson', status: 'busy', currentCall: 'CA123456' },
    { id: 3, name: 'Mike Wilson', status: 'available', currentCall: null },
    { id: 4, name: 'Lisa Brown', status: 'offline', currentCall: null }
  ];
  res.json(agents);
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Serve static files for dashboard
app.use(express.static('public'));

app.listen(port, () => {
  console.log(`AI Call Center server running on port ${port}`);
  console.log(`Webhook URL: http://localhost:${port}/webhook/voice`);
  console.log(`Dashboard: http://localhost:${port}`);
});

module.exports = app;