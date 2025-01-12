require('dotenv').config();
const express = require('express');
const fs = require('fs');
const OpenAI = require('openai');
const cors = require('cors');
const { approvedApplicants } = require('./config');

const app = express();
const port = process.env.PORT || 8000;

// Initialize OpenAI
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// Cache the CSV data
let applicantsData = null;

function loadApplicantsData() {
    try {
        if (!applicantsData) {
            console.log('Loading applicants data from file');
            const data = fs.readFileSync('fresh_data.csv', 'utf8');
            const rows = data.split('\n');
            const headers = rows[0].split('\t');
            applicantsData = rows.slice(1).map((row, index) => {
                const values = row.split('\t');
                const applicant = headers.reduce((obj, header, i) => {
                    obj[header] = values[i];
                    return obj;
                }, {});
                applicant.id = index + 1;
                return applicant;
            });
            console.log(`Loaded ${applicantsData.length} applicants`);
        }
        return applicantsData;
    } catch (error) {
        console.error('Error loading applicants:', error);
        return [];
    }
}

// Metric evaluation prompts
const metricPrompts = {
    completion: `Based on the applicant's background information, rate on a scale of 1-100 how likely they are to complete the entire Appalachian Trail. Consider their motivation, determination, past challenges, and stated goals. Provide only a numeric score.`,
    
    spokesperson: `Based on the applicant's background information, rate on a scale of 1-100 how effective they would be as a spokesperson for One More Day on the AT. Consider how well they align with the mission of personal growth through hiking the AT, their ability to articulate their journey, and their potential to inspire others. Provide only a numeric score.`,
    
    physical: `Based on the applicant's background information, rate on a scale of 1-100 their physical capability to handle the AT challenge. Consider any mentioned physical activities, fitness level, or health-related information. If physical fitness is not explicitly mentioned, base the score on their described activities and lifestyle. Provide only a numeric score.`
};

async function getMetricScore(applicant, metricType) {
    try {
        console.log(`Calculating ${metricType} metric for ${applicant['First Name']}`);
        const applicantInfo = `
Location: ${applicant['City']}, ${applicant['State']}
About them: ${applicant['Tell us about yourself.']}
Why they applied: ${applicant['What drew you to apply for this scholarship?']}
Their challenges: ${applicant['What is a challenge or obstacle that you have faced, or are currently facing, and how might time on the trail help you to better meet this challenge?']}
Their inspiration: ${applicant['Where do you find inspiration when faced with challenges and obstacles? When has your courage surprised you?']}
Their goals: ${applicant['At the end of your hike (whether or not you complete the entire 2,190 miles), what do you wish for yourself?']}
Additional info: ${applicant['Is there anything else you would like to share or that we should consider as we are making our decision?']}`;

        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { 
                    role: "system", 
                    content: `You are an expert evaluator for AT scholarship applicants. Analyze the information and provide a single number score (1-100) based on the specific criteria. Only respond with the numeric score, no explanation.`
                },
                {
                    role: "user",
                    content: `${metricPrompts[metricType]}\n\nApplicant Information:\n${applicantInfo}`
                }
            ],
            temperature: 0.3,
            max_tokens: 10
        });

        console.log(`${metricType} response:`, completion.choices[0].message.content);
        const score = parseInt(completion.choices[0].message.content.trim());
        return isNaN(score) ? 50 : Math.min(100, Math.max(1, score));
    } catch (error) {
        console.error(`Error calculating ${metricType} metric:`, error);
        return 50; // Default score on error
    }
}

// Password for authentication
const REVIEW_PASSWORD = 'PatBurke31';

// Authentication middleware
function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${REVIEW_PASSWORD}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

// Login endpoint
app.post('/api/login', (req, res) => {
    const { password } = req.body;
    if (password === REVIEW_PASSWORD) {
        res.json({ success: true });
    } else {
        res.json({ success: false });
    }
});

// Get all applicants, both approved and additional
app.get('/api/applicants', requireAuth, (req, res) => {
    try {
        const applicants = loadApplicantsData();
        // Split into approved and additional applicants
        const approvedApplicantsList = applicants.filter(applicant => 
            approvedApplicants.includes(applicant['Email'])
        );
        const additionalApplicantsList = applicants.filter(applicant => 
            !approvedApplicants.includes(applicant['Email'])
        );
        
        console.log('Sending applicants data - Approved:', approvedApplicantsList.length, 
                  'Additional:', additionalApplicantsList.length);
        
        res.json({
            approved: approvedApplicantsList,
            additional: additionalApplicantsList
        });
    } catch (error) {
        console.error('Error getting applicants:', error);
        res.status(500).json({ error: 'Failed to get applicants' });
    }
});

// New endpoint to get all metrics for an applicant
app.get('/api/metrics/:id', requireAuth, async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        console.log('Fetching metrics for applicant ID:', id);
        
        const applicants = loadApplicantsData();
        const applicant = applicants.find(a => a.id === id);

        if (!applicant) {
            console.error('Applicant not found for ID:', id);
            return res.status(404).json({ error: 'Applicant not found' });
        }

        if (!approvedApplicants.includes(applicant['Email'])) {
            console.error('Applicant not approved:', applicant['Email']);
            return res.status(403).json({ error: 'Applicant not approved' });
        }

        console.log('Calculating metrics for:', applicant['First Name'], '(Email:', applicant['Email'], ')');
        const [completion, spokesperson, physical] = await Promise.all([
            getMetricScore(applicant, 'completion'),
            getMetricScore(applicant, 'spokesperson'),
            getMetricScore(applicant, 'physical')
        ]);

        const metrics = {
            completion,
            spokesperson,
            physical
        };
        
        console.log('Metrics calculated for', applicant['First Name'], ':', metrics);
        res.json(metrics);
    } catch (error) {
        console.error('Error getting metrics:', error);
        res.status(500).json({ error: 'Failed to get metrics', details: error.message });
    }
});

// New endpoint to get approved applicants list
app.get('/api/approved-applicants', (req, res) => {
    try {
        const applicants = loadApplicantsData();
        // Only send necessary information for the list
        const applicantsList = applicants.map(applicant => ({
            id: applicant.id,
            firstName: applicant['First Name'],
            lastName: applicant['Last Name'],
            city: applicant['City'],
            state: applicant['State']
        }));
        res.json(applicantsList);
    } catch (error) {
        console.error('Error getting applicants:', error);
        res.status(500).json({ error: 'Failed to load applicants' });
    }
});

app.post('/api/chat', requireAuth, async (req, res) => {
    try {
        console.log('Received chat request:', req.body);
        const { applicantId, message } = req.body;
        
        if (!applicantId || !message) {
            console.error('Missing required fields:', { applicantId, message });
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const applicants = loadApplicantsData();
        console.log(`Looking for applicant ID: ${applicantId}`);
        const applicant = applicants.find(a => a.id === parseInt(applicantId));

        if (!applicant) {
            console.error(`Applicant not found for ID: ${applicantId}`);
            return res.status(404).json({ error: 'Applicant not found' });
        }

        if (!approvedApplicants.includes(applicant['Email'])) {
            console.error(`Applicant not approved: ${applicant['Email']}`);
            return res.status(403).json({ error: 'Applicant not approved' });
        }

        console.log('Creating chat completion for applicant:', applicant['First Name']);
        const systemPrompt = `You are ${applicant['First Name']} ${applicant['Last Name']}, an applicant for the One More Day AT Scholarship from ${applicant['City']}, ${applicant['State']}. 

Here is your background information:

Location: ${applicant['City']}, ${applicant['State']}
About you: ${applicant['Tell us about yourself.']}
Why you applied: ${applicant['What drew you to apply for this scholarship?']}
Your challenges: ${applicant['What is a challenge or obstacle that you have faced, or are currently facing, and how might time on the trail help you to better meet this challenge?']}
Your inspiration: ${applicant['Where do you find inspiration when faced with challenges and obstacles? When has your courage surprised you?']}
Your goals: ${applicant['At the end of your hike (whether or not you complete the entire 2,190 miles), what do you wish for yourself?']}
Additional info: ${applicant['Is there anything else you would like to share or that we should consider as we are making our decision?']}

IMPORTANT INSTRUCTIONS:
1. Only respond with information that is explicitly stated in your background information above.
2. If asked about something not covered in your background information, respond with: "I apologize, but I can only speak about information that was included in my scholarship application. That specific detail wasn't mentioned in my application."
3. Never make up or infer information that isn't explicitly stated.
4. Keep your responses authentic to your application's tone and content.
5. If asked about personal details not included (like specific dates, family members, or experiences not mentioned), politely decline to provide that information.
6. Be honest about your location and only reference ${applicant['City']}, ${applicant['State']} as your location.

Remember: It's better to acknowledge what you don't know than to make up information.`;

        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: message }
            ],
            temperature: 0.5, // Lowered temperature for more consistent responses
            max_tokens: 500
        });

        console.log('Received response from OpenAI');
        res.json({ response: completion.choices[0].message.content });
    } catch (error) {
        console.error('Error in /api/chat:', error);
        res.status(500).json({ 
            error: 'An error occurred while processing your request',
            details: error.message 
        });
    }
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
    console.log('Environment:', {
        port: port,
        hasOpenAIKey: !!process.env.OPENAI_API_KEY
    });
});
