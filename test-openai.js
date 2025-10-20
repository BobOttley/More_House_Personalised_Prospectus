require('dotenv').config();
const OpenAI = require('openai');

async function testOpenAI() {
  console.log('Testing OpenAI API...');
  console.log('API Key exists:', !!process.env.OPENAI_API_KEY);
  console.log('API Key prefix:', process.env.OPENAI_API_KEY?.substring(0, 15) + '...');
  
  try {
    const openai = new OpenAI({ 
      apiKey: process.env.OPENAI_API_KEY 
    });
    
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: "Say hello!" }],
      max_tokens: 20
    });
    
    console.log('\n✅ SUCCESS! API key is valid');
    console.log('Response:', completion.choices[0].message.content);
    
  } catch (error) {
    console.log('\n❌ ERROR:', error.message);
    console.log('Error code:', error.code);
  }
}

testOpenAI();
