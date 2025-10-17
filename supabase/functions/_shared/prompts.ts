interface HtmlGuardrailFindings {
  struck_through_items: string[];
  formatting_notes: string;
}

export function buildHtmlGuardrailPrompt(htmlContent: string): string {
  return `You are an HTML formatting analyzer for email responses.

Your job: Scan this HTML email and identify formatting signals that indicate user intent.

FORMATTING SIGNALS TO DETECT:
1. Strikethrough: <strike>, <del>, <s> tags or style="text-decoration: line-through"
2. Which invite letters (A-Z) are struck through
3. Any other notable formatting (bold sections, highlights, etc.)

HTML CONTENT:
"""
${htmlContent}
"""

Return JSON strictly as:
{
  "struck_through_items": ["A", "B"],
  "formatting_notes": "Any other relevant HTML formatting observations"
}`;
}

function responseExamples(): string {
  const singleExamples = [
    `- "A" -> yes for invite A`,
    `- "B." -> yes for invite B`,
    `- "C yes" -> yes for C`,
    `- "D - yes" -> yes for D`,
    `- "E yes please" -> yes for E`,
    `- "F please lock it in" -> yes for F`,
    `- "G no" -> no for G`,
    `- "H - no thanks" -> no for H`,
    `- "I pass" -> no for I`,
    `- "J maybe" -> maybe for J`,
    `- "K - maybe, lean yes" -> maybe for K`,
    `- "L on hold" -> maybe for L`,
    `- "M yes, see you there" -> yes for M with note see you there`,
    `- "N no, double booked" -> no for N with note double booked`,
    `- "O maybe, check back later" -> maybe for O with note check back later`,
    `- "P confirmed" -> yes for P`,
    `- "Q decline" -> no for Q`,
    `- "R tentative" -> maybe for R`,
    `- "S absolutely" -> yes for S`,
    `- "T - out" -> no for T`,
    `- "U leaning maybe" -> maybe for U`,
    `- "V yes - lunch after?" -> yes for V with note lunch after`,
    `- "W no - traveling" -> no for W with note traveling`,
    `- "X maybe - pending client" -> maybe for X with note pending client`,
  ];

  const comboExamples = [
    `- "A & B" -> yes for A and B`,
    `- "C & D yes" -> yes for C and D`,
    `- "E & F no" -> no for E and F`,
    `- "G & H maybe" -> maybe for G and H`,
    `- "I & J both yes" -> yes for I and J`,
    `- "K & L both no" -> no for K and L`,
    `- "M & N both maybe" -> maybe for M and N`,
    `- "O & P yes please" -> yes for O and P with note yes please`,
    `- "Q & R - no sorry" -> no for Q and R with note sorry`,
    `- "S & T are a go" -> yes for S and T`,
    `- "U & V are out" -> no for U and V`,
    `- "W & X tentative" -> maybe for W and X`,
    `- "Y & Z good to go" -> yes for Y and Z`,
    `- "A & D & F yes" -> yes for A, D, and F`,
    `- "B & C & E no" -> no for B, C, and E`,
    `- "G & H & I maybe" -> maybe for G, H, and I`,
    `- "A + B yes" -> yes for A and B`,
    `- "C + D no" -> no for C and D`,
    `- "E + F maybe" -> maybe for E and F`,
    `- "Invite A and B are yes" -> yes for A and B`,
  ];

  const rangeExamples = [
    `- "A-D yes" -> yes for A, B, C, D`,
    `- "E-G no" -> no for E, F, G`,
    `- "H-J maybe" -> maybe for H, I, J`,
    `- "A to C yes" -> yes for A, B, C`,
    `- "D thru F no" -> no for D, E, F`,
    `- "G through I maybe" -> maybe for G, H, I`,
    `- "J-L all yes" -> yes for J, K, L`,
    `- "M-O all no" -> no for M, N, O`,
    `- "P-R all maybe" -> maybe for P, Q, R`,
    `- "S-U yes please" -> yes for S, T, U`,
    `- "V-X no thanks" -> no for V, W, X`,
    `- "Y-Z maybe later" -> maybe for Y and Z`,
  ];

  const inlineExamples = [
    `- "A: yes\nB: no" -> yes for A, no for B`,
    `- "A - yes\nB - maybe\nC - no" -> yes for A, maybe for B, no for C`,
    `- "A) yes\nB) yes\nC) no" -> yes for A, yes for B, no for C`,
    `- "A - yep\nB - nope" -> yes for A, no for B`,
    `- "A -> yes with Jamie\nB -> pass" -> yes for A with note with Jamie, no for B`,
    `- "A = yes\nC = no" -> yes for A, no for C`,
    `- "A - confirm\nC - tentative" -> yes for A, maybe for C`,
    `- "A (yes)\nB (no)\nD (maybe)" -> yes for A, no for B, maybe for D`,
    `- "A ok\nB not happening" -> yes for A, no for B`,
    `- "A works\nB does not\nC maybe" -> yes for A, no for B, maybe for C`,
    `- "A yes, B no, C maybe" -> yes for A, no for B, maybe for C`,
    `- "A yes; B yes; C no" -> yes for A, yes for B, no for C`,
    `- "A yes // B no" -> yes for A, no for B`,
    `- "A - bring Sam\nB - cannot\nC - pencil me in" -> yes for A with note bring Sam, no for B with note cannot, maybe for C with note pencil me in`,
    `- "A done\nC pass" -> yes for A, no for C`,
    `- "A yes - need 2pm\nB maybe - travel" -> yes for A with note need 2pm, maybe for B with note travel`,
  ];

  const htmlExamples = [
    `- "HTML with <s>A</s>" -> guardrail marks A as no`,
    `- "HTML with <del>B</del> and text C yes" -> B no, C yes`,
    `- "HTML span style=text-decoration:line-through wrapping D" -> D no`,
    `- "HTML list item <li><strike>E</strike></li><li>F yes</li>" -> E no, F yes`,
    `- "HTML table cell for G is struck through" -> G no`,
    `- "HTML reply that bolds H yes" -> H yes with emphasis`,
    `- "HTML reply showing <s>I</s> even though text says I yes" -> strikethrough wins and I is no`,
    `- "HTML reply with <strong>J maybe</strong>" -> J maybe`,
    `- "HTML highlight <mark>K yes</mark>" -> K yes with highlight`,
    `- "HTML italic line L no" -> L no`,
    `- "HTML bullet with <s>M</s> and <s>N</s>" -> M and N no`,
  ];

  const complexExamples = [
    `- "A & B yes, C no" -> yes for A and B, no for C`,
    `- "A-B yes, D no" -> yes for A and B, no for D`,
    `- "All of A-C yes" -> yes for A, B, C`,
    `- "All invites no" -> no for every invite in the digest`,
    `- "Everything except C" -> yes for all invites except C which is no`,
    `- "Everyone but D is a go" -> yes for all except D which is no`,
    `- "Only A" -> yes for A, others unchanged`,
    `- "A yes, others no" -> A yes, all others no`,
    `- "A yes, leave B open" -> A yes, B maybe`,
    `- "A yes. C maybe. Rest no." -> A yes, C maybe, others no`,
    `- "A (yes) / B (no) / rest pending" -> A yes, B no, others maybe`,
    `- "A & B - confirmed, D-F - decline" -> A and B yes, D E F no`,
    `- "A yes, B struck in HTML" -> A yes, B no via guardrail`,
    `- "A yes - bring deck" -> A yes with note bring deck`,
    `- "B no - client conflict" -> B no with note client conflict`,
    `- "C maybe - waiting on travel" -> C maybe with note waiting on travel`,
    `- "A -> yes, B -> maybe, C -> no" -> respective decisions`,
  ];

  const bulkExamples = [
    `- "A: yes (definite) B: maybe (if remote)" -> A yes, B maybe with note if remote`,
    `- "A: yes - B: yes - C: yes" -> all yes`,
    `- "A: cannot. B: cannot either." -> no for A and B`,
    `- "A: on hold. B: go ahead." -> A maybe, B yes`,
    `- "A good. B good. C maybe later." -> A yes, B yes, C maybe`,
    `- "A y, B n, C m" -> A yes, B no, C maybe`,
    `- "A=Y, B=N" -> A yes, B no`,
    `- "A=accept, B=decline" -> A yes, B no`,
    `- "A accepted, B declined" -> A yes, B no`,
    `- "A - y\nB - n\nC - m" -> yes, no, maybe for A, B, C`,
    `- "A - sure thing / B - negative" -> A yes, B no`,
    `- "A - yes // B - ???" -> A yes, B maybe`,
    `- "A is a yes but pencil B" -> A yes, B maybe`,
    `- "A still no, B now yes" -> A no, B yes`,
    `- "A upgrade me to yes, B stay no" -> A yes, B no`,
    `- "A yes pending final agenda" -> A maybe with note pending final agenda`,
    `- "B no unless it moves" -> B no with note unless it moves`,
    `- "C maybe leaning no" -> C maybe with note leaning no`,
    `- "D yes if virtual" -> D yes with note if virtual`,
    `- "E no unless earlier" -> E no with note unless earlier`,
  ];

  const examples = [
    ...singleExamples,
    ...comboExamples,
    ...rangeExamples,
    ...inlineExamples,
    ...htmlExamples,
    ...complexExamples,
    ...bulkExamples,
  ];

  return examples.join("\n");
}

export function buildResponseAnalyzerPrompt(
  emailText: string,
  htmlGuardrailFindings: HtmlGuardrailFindings,
  originalDigest: string,
): string {
  return `You are analyzing a user's reply to their Mindspire digest email.

CONTEXT:
- Original digest listed invites with letters (A, B, C, etc.)
- User is responding with their decisions (yes, no, maybe) and optional notes
- HTML guardrail detected: ${JSON.stringify(htmlGuardrailFindings)}

RESPONSE FORMATS YOU MUST RECOGNIZE:
${responseExamples()}

OUTPUT REQUIREMENTS:
- Return a JSON array where each element represents one invite decision
- Each element must have: invite_id (string), decision ("yes" | "no" | "maybe"), notes (string, optional), confidence (0-1 number)
- Always include confidence. Use 0.99 for clear intent, 0.5 for ambiguous, etc.
- Use notes to preserve meaningful natural language context or instructions
- If the reply indicates decisions for every invite (e.g., "all yes"), reflect that explicitly
- If an invite is explicitly excluded (e.g., "everything except C"), mark that invite with the opposite decision if implied

ORIGINAL DIGEST CONTEXT:
"""
${originalDigest}
"""

EMAIL RESPONSE TO ANALYZE:
"""
${emailText}
"""

Return ONLY valid JSON.`;
}
