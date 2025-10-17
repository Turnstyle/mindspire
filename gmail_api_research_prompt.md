# Gmail API Search Bug - Comprehensive Research Request

## **URGENT PRODUCTION ISSUE** 
**Timeline: System digest email scheduled in 5 hours - Gmail integration completely broken**

## **Research Mission**
Investigate Gmail API search returning zero results for emails that exist and are visible in Gmail web interface. Search across GitHub issues, StackOverflow, Reddit, X/Twitter, Google Developer forums, and any other relevant technical communities for similar issues, root causes, and solutions.

## **Core Technical Problem**
- **Gmail API Search Query**: `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=newer_than:3d&maxResults=100`
- **Expected Result**: Find emails from Oct 13-15, 2025 (confirmed to exist in Gmail web interface)
- **Actual Result**: Returns empty results (`messages: undefined` or `messages: []`)
- **Authentication Status**: OAuth working successfully, no 401/403 errors
- **Search Response Time**: ~3.2 seconds (indicating no processing/empty results vs normal 40-142 seconds when emails found)

## **System Architecture Details**
- **Platform**: TypeScript/Deno on Supabase Edge Functions  
- **Gmail API Version**: v1 REST API
- **OAuth Scopes**: `gmail.readonly`, `calendar.readonly`, `calendar.settings.readonly`
- **Authentication Method**: OAuth2 with stored access/refresh tokens
- **User Email**: turnerpeters@gmail.com  
- **Project**: Supabase project hzrmmunlgcjghjrjouxa

## **Confirmed Working Components**
- ✅ OAuth authentication (successful re-authorization)
- ✅ Gmail API connection (no auth errors) 
- ✅ Token refresh mechanism
- ✅ Vertex AI/Gemini parsing (when emails found)
- ✅ Database and cron infrastructure

## **Search Variations Tested (All Returned Zero Results)**
1. `newer_than:30d` - 30-day backfill
2. `newer_than:3d` - 3-day backfill  
3. `(from:slb721@gmail.com OR from:go1903@vpstl.org)` - Targeted sender search
4. Removed `label:inbox` restriction (searches ALL MAIL now)
5. Various `maxResults` values (25, 50, 100, 500)

## **Specific Emails That Should Be Found**
1. **From**: go1903@vpstl.org, **Date**: Oct 14, 2025 4:54 PM, **Subject**: "The Annual Sporting Clay Shoot is happening soon"
2. **From**: slb721@gmail.com, **Date**: Oct 13, 2025 6:26 PM, **Subject**: "Howdy: Want to shoot the breeze?"

## **Research Focus Areas**

### **1. Gmail API Search Discrepancies**
Search for issues where:
- Gmail API returns different results than Gmail web interface
- API searches return empty when emails exist
- "newer_than" date queries not working as expected
- Gmail API sync delays or indexing issues
- Differences between IMAP, POP, and REST API access

### **2. OAuth Scope and Permission Issues**
Investigate:
- OAuth scopes that appear to work but have hidden limitations
- `gmail.readonly` vs `gmail.modify` scope differences
- Service account vs user account permission issues
- Google Workspace vs personal Gmail account API differences
- Cases where authentication succeeds but data access fails

### **3. Gmail API Rate Limiting & Quota Issues**
Look for:
- Silent rate limiting that returns empty results instead of 429 errors
- Daily/hourly quota exhaustion scenarios
- Gmail API quotas for specific operations (search vs read)
- Quota reset timing and how it affects search results

### **4. Date and Timezone Handling**
Research:
- Gmail API date parsing edge cases with "newer_than" queries
- Timezone mismatches between server time and Gmail time
- ISO8601 vs other date format issues in Gmail searches
- Daylight saving time transitions affecting search results

### **5. Gmail API Caching and Consistency Issues**
Find examples of:
- Gmail API serving stale/cached results
- Eventual consistency problems with recent emails
- Push notification vs polling discrepancies  
- History API vs search API inconsistencies

### **6. TypeScript/Deno Specific Issues**
Search for:
- Deno-specific Gmail API integration problems
- TypeScript fetch() issues with Google APIs
- Edge function environments causing API issues
- Supabase Edge Functions + Gmail API known problems

### **7. Alternative Search Strategies**
Look for working solutions using:
- Different Gmail API endpoints for finding recent emails
- Gmail History API as alternative to search
- Push notifications instead of polling
- IMAP alternatives for reliable email access
- Batch API calls vs individual requests

## **Specific Search Queries to Run**

### **GitHub Issues**
- `gmail api search returns empty results emails exist`
- `gmail.googleapis.com newer_than not working`
- `gmail oauth scope readonly empty search`
- `gmail api messages endpoint no results`
- `typescript gmail api search problems`
- `supabase edge functions gmail api issues`

### **StackOverflow**
- `[gmail-api] search returns empty but emails exist`
- `[oauth2] gmail.readonly scope limitations`
- `[typescript] gmail api v1 search problems`
- `gmail api newer_than query not finding emails`
- `gmail web interface vs api results different`

### **Reddit Communities**  
Search in r/webdev, r/typescript, r/GoogleCloud, r/sysadmin:
- "Gmail API not finding emails that exist"
- "OAuth Gmail API empty search results"
- "Gmail API vs Gmail web interface inconsistency"

### **Google Developer Forums**
- Gmail API known issues with search functionality
- OAuth scope documentation discrepancies
- Gmail API quota and rate limiting edge cases

## **Expected Research Deliverables**

### **Issue Classification**
1. **Root Cause Analysis**: Most likely technical explanations for this behavior
2. **Similar Cases**: Document identical or similar issues found in communities
3. **Confirmed Bugs**: Any known Gmail API bugs matching this description
4. **Workarounds**: Alternative approaches that work when search fails

### **Solution Categories**
1. **Immediate Fixes**: Code changes that could resolve this in next few hours
2. **API Alternatives**: Different Gmail/Google API endpoints to try
3. **Authentication Fixes**: OAuth scope or token configuration changes  
4. **Polling Strategies**: Different ways to detect new emails

### **Implementation Resources**
1. **Working Code Examples**: GitHub repos, gists, or SO answers with working Gmail API search
2. **Configuration Examples**: Proper OAuth setup, scopes, and API usage patterns
3. **Debugging Tools**: Methods to inspect API requests/responses and diagnose issues
4. **Testing Approaches**: How to reliably test Gmail API integration

## **Urgency Context**
- **Production System Down**: Email invitation processing completely broken
- **Time-Critical**: Automated digest email scheduled to send in 5 hours
- **User Impact**: System supposed to parse meeting invitations from Gmail for users
- **Business Impact**: Core product functionality non-operational

## **Success Criteria**
Research is successful if it provides:
1. **Root cause identification** with technical explanation
2. **At least 2-3 potential solutions** with implementation details  
3. **Working code examples** or configuration changes
4. **Similar issue resolution** documented in developer communities
5. **Alternative approaches** if main Gmail API search cannot be fixed quickly

**PRIORITIZE**: Solutions that can be implemented within 2-4 hours to restore service before the scheduled digest email.
