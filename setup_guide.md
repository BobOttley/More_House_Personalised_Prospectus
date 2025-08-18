# 🎯 More House School - Phase 1 Setup Guide

## ✅ **What We've Built**

### **1. Standalone Inquiry Form** (`inquiry-form.html`)
- Complete form with **all required fields** including missing surname and parent email
- **Webhook submission** capability with configurable URL
- **Professional styling** matching More House branding
- **Real-time validation** and error handling

### **2. Prospectus Template Engine** (`prospectus-template.html`)
- **Clean template** without form elements
- **Personalization engine** via `initializeProspectus(userData)` function
- **All personalization features** preserved from original
- **Ready for file generation**

### **3. Express.js Webhook Server** (`server.js`)
- **Webhook receiver** at `/webhook` endpoint
- **JSON data logging** with structured console output
- **File storage** in `data/` directory
- **API endpoints** for inquiry management
- **Error handling** and validation

---

## 🚀 **Quick Start Instructions**

### **Step 1: Setup Project Structure**
```bash
mkdir more-house-app
cd more-house-app

# Create the files
touch server.js package.json
mkdir data prospectuses public

# Copy the artifacts into these files:
# - server.js (Express webhook server)
# - package.json (Node dependencies)
# - public/inquiry-form.html (Inquiry form)
# - public/prospectus-template.html (Template engine)
```

### **Step 2: Install Dependencies**
```bash
npm install
# This installs: express, cors
# Dev dependencies: nodemon (optional)
```

### **Step 3: Start the Webhook Server**
```bash
npm start
# OR for development with auto-restart:
npm run dev
```

**You should see:**
```
🚀 MORE HOUSE WEBHOOK SERVER STARTED
═══════════════════════════════════════
🌐 Server running on: http://localhost:3000
📋 Webhook endpoint: http://localhost:3000/webhook
📊 Health check: http://localhost:3000/health
📝 List inquiries: http://localhost:3000/api/inquiries
═══════════════════════════════════════
✅ Ready to receive form submissions!
```

### **Step 4: Test the Form**
1. **Open the form**: `http://localhost:3000/inquiry-form.html`
2. **Fill out test data**:
   - Daughter's Name: `Sarah`
   - Family Surname: `Smith`
   - Parent Email: `test@example.com`
   - Age Group: `11-16`
   - Entry Year: `2025`
   - Select some interests
3. **Click "Create My Personalised Prospectus"**

---

## 📊 **Expected Results**

### **Console Output (Server)**
```
🎯 WEBHOOK RECEIVED
📅 Timestamp: 2025-01-16T...

📋 FORM DATA RECEIVED:
═══════════════════════════════════════
👨‍👩‍👧 FAMILY INFORMATION:
   Name: Sarah Smith
   Email: test@example.com
   Age Group: 11-16
   Entry Year: 2025

📚 ACADEMIC INTERESTS:
   sciences, mathematics

🎨 CREATIVE INTERESTS:
   drama, music

🏃‍♀️ CO-CURRICULAR INTERESTS:
   sport, leadership

💝 FAMILY PRIORITIES:
   academic_excellence, pastoral_care
═══════════════════════════════════════

📄 Suggested prospectus filename: More-House-School-Smith-Family-Sarah-2025-2025-01-16.html
✅ WEBHOOK RESPONSE SENT: INQ-1737040123456
```

### **Saved Data File** (`data/inquiry-2025-01-16T...json`)
```json
{
  "firstName": "Sarah",
  "familySurname": "Smith",
  "parentEmail": "test@example.com",
  "ageGroup": "11-16",
  "entryYear": "2025",
  "sciences": true,
  "mathematics": true,
  "drama": true,
  "music": true,
  "sport": true,
  "leadership": true,
  "academic_excellence": true,
  "pastoral_care": true,
  "id": "INQ-1737040123456",
  "receivedAt": "2025-01-16T...",
  "status": "received",
  "prospectusGenerated": false
}
```

### **Form Success Message**
- Form shows success message
- Form resets to blank
- Data appears in server console

---

## 🔧 **API Endpoints Available**

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/` | GET | Server info and status |
| `/webhook` | POST | **Main form submission endpoint** |
| `/health` | GET | Health check |
| `/api/inquiries` | GET | List all inquiries |
| `/api/inquiries/:id` | GET | Get specific inquiry |

### **Test API Endpoints:**
```bash
# Health check
curl http://localhost:3000/health

# List all inquiries
curl http://localhost:3000/api/inquiries

# Get specific inquiry
curl http://localhost:3000/api/inquiries/INQ-1737040123456
```

---

## 📁 **Project Structure**
```
more-house-app/
├── server.js                      # Express webhook server
├── package.json                   # Node.js dependencies
├── data/                          # Inquiry JSON files
│   └── inquiry-2025-01-16T....json
├── prospectuses/                  # Generated prospectus files (Phase 2)
└── public/                        # Static web files
    ├── inquiry-form.html          # Standalone inquiry form
    └── prospectus-template.html   # Template engine
```

---

## ✅ **Phase 1 Success Criteria**

- [x] **Form submits data via webhook** ✅
- [x] **Server receives and logs form data** ✅ 
- [x] **JSON structure visible for database planning** ✅
- [x] **Missing fields added** (family surname, parent email) ✅
- [x] **Proper error handling** ✅
- [x] **File naming convention established** ✅

---

## 🚀 **Ready for Phase 2**

**Next Steps:**
1. **Prospectus Generation**: Load template, inject data, save HTML file
2. **File Management**: Serve generated prospectuses via HTTP
3. **Template Injection**: `initializeProspectus(userData)` integration

**File naming established:**
```
More-House-School-Smith-Family-Sarah-2025-2025-01-16.html
```

**Data flow proven:**
```
Form → Webhook → JSON Storage → Console Logging ✅
```

---

## 🐛 **Troubleshooting**

### **Common Issues:**

**1. Port 3000 already in use:**
```bash
export PORT=3001
npm start
```

**2. Form shows CORS error:**
- Check server is running on `localhost:3000`
- Webhook URL in form matches server port

**3. Form data not appearing:**
- Check browser console for errors
- Verify webhook URL is correct
- Check server console for error messages

**4. File permission errors:**
```bash
chmod 755 data/ prospectuses/ public/
```

---

## 📞 **Support**

If you encounter issues:
1. Check server console output
2. Check browser developer tools
3. Verify all files are in correct locations
4. Ensure Node.js version >= 16.0.0

**Phase 1 complete!** 🎉 Ready to build prospectus generation in Phase 2.