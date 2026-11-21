#!/usr/bin/env python3
"""Rebuild the sample documents in data/samples/.

The generated files are committed to the repo, so you only need this script
if you want to regenerate them.

    pip install reportlab python-docx
    python scripts/prepare_samples.py

What it produces:
  * pep-0008-style-guide.rst          - PEP 8 (public domain), downloaded from python/peps
  * mcp-specification-2026-07-28.md   - selected MCP spec pages (Apache-2.0), MDX converted to Markdown
  * northwind-employee-handbook.pdf   - fictional company handbook (generated here)
  * northwind-security-policy.docx    - fictional IT security policy (generated here)
"""

from __future__ import annotations

import re
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "samples"

PEP8_URL = "https://raw.githubusercontent.com/python/peps/main/peps/pep-0008.rst"
MCP_COMMIT = "bbc31f8ded5762eae4df115b93942f5e71c8b3a7"
MCP_BASE = (
    "https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/"
    f"{MCP_COMMIT}/docs/specification/2026-07-28"
)
MCP_PAGES = [
    "index",
    "changelog",
    "architecture/index",
    "basic/transports/index",
    "basic/transports/stdio",
    "basic/transports/streamable-http",
    "server/tools",
]


def fetch(url: str) -> str:
    with urllib.request.urlopen(url, timeout=30) as resp:  # noqa: S310 (trusted GitHub URL)
        return resp.read().decode("utf-8")


# --------------------------------------------------------------------------- #
# MCP spec: MDX -> Markdown
# --------------------------------------------------------------------------- #
def mdx_to_markdown(mdx: str) -> str:
    title = ""
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n", mdx, flags=re.S)
    if m:
        t = re.search(r"^title:\s*(.+)$", m.group(1), flags=re.M)
        title = t.group(1).strip().strip("\"'") if t else ""
        mdx = mdx[m.end():]

    mdx = re.sub(r"<div[^>]*/>\s*", "", mdx)
    mdx = re.sub(r"^(import|export) .*$", "", mdx, flags=re.M)

    # <Card title="X" href="Y" ... /> or <Card ...>...</Card>  ->  "- X (Y)"
    def card(match: re.Match[str]) -> str:
        attrs = match.group(1)
        t = re.search(r'title="([^"]+)"', attrs)
        h = re.search(r'href="([^"]+)"', attrs)
        label = t.group(1) if t else "Link"
        return f"- {label} ({h.group(1)})" if h else f"- {label}"

    mdx = re.sub(r"<Card\s+([^>]*?)/>", card, mdx, flags=re.S)
    mdx = re.sub(r"<Card\s+([^>]*?)>(.*?)</Card>", card, mdx, flags=re.S)
    mdx = re.sub(r"</?CardGroup[^>]*>", "", mdx)

    for tag in ("Note", "Warning", "Info", "Tip"):
        mdx = re.sub(rf"<{tag}>\s*", f"> **{tag}:** ", mdx)
        mdx = re.sub(rf"\s*</{tag}>", "", mdx)

    mdx = re.sub(r"\n{3,}", "\n\n", mdx).strip()
    return f"# {title}\n\n{mdx}\n" if title else mdx + "\n"


def build_mcp_spec() -> None:
    parts = [
        "# Model Context Protocol Specification (revision 2026-07-28), selected pages\n",
        "> Source: https://github.com/modelcontextprotocol/modelcontextprotocol "
        f"(commit {MCP_COMMIT[:7]}), docs/specification/2026-07-28.\n"
        "> License: Apache-2.0 (some older contributions remain under MIT). "
        "MDX components were converted to plain Markdown; content is otherwise unchanged.\n",
    ]
    for page in MCP_PAGES:
        md = mdx_to_markdown(fetch(f"{MCP_BASE}/{page}.mdx"))
        url = f"https://modelcontextprotocol.io/specification/2026-07-28/{page}".removesuffix("/index")
        md = re.sub(r"^# (.+)$", rf"# \1\n\n_Page: {url}_", md, count=1, flags=re.M)
        parts.append("\n---\n\n" + md)
    (OUT / "mcp-specification-2026-07-28.md").write_text("\n".join(parts), encoding="utf-8")


# --------------------------------------------------------------------------- #
# Fictional employee handbook (PDF)
# --------------------------------------------------------------------------- #
HANDBOOK: list[tuple[str, list[object]]] = [
    (
        "1. Welcome to Northwind Labs",
        [
            "Northwind Labs, Inc. builds developer tools for data teams. The company was founded in 2019, "
            "is headquartered in Seattle, Washington, and has additional offices in Austin, Texas and "
            "Toronto, Canada. As of January 2026 we have about 420 employees.",
            "This handbook applies to all full-time employees based in the United States and is effective "
            "January 1, 2026. It replaces all earlier versions. If a local law gives you more generous "
            "rights than this handbook, the local law applies.",
            "Questions about this handbook go to the People team at people@northwind.example.",
        ],
    ),
    (
        "2. Working Hours and Hybrid Work",
        [
            "Northwind uses a hybrid schedule. Employees who live within 50 miles of an office work "
            "on-site three days a week: Tuesday, Wednesday and Thursday (our “anchor days”). "
            "Monday and Friday are flexible remote days.",
            "Core collaboration hours are 10:00 a.m. to 3:00 p.m. Pacific Time. Outside core hours you "
            "may arrange your schedule with your manager. Fridays are “Focus Fridays”: no "
            "internal recurring meetings are scheduled on Fridays.",
            "Fully remote roles require approval from a vice president. Remote and hybrid employees "
            "receive a one-time $500 home-office setup allowance and a $75 monthly stipend for internet "
            "and utilities.",
        ],
    ),
    (
        "3. Paid Time Off (PTO)",
        [
            "PTO accrues every semi-monthly pay period, starting on your first day. Your annual "
            "allotment depends on your years of service:",
            [
                ["Years of service", "Annual PTO days", "Accrued per pay period"],
                ["0 to 2 years", "18 days", "0.75 days"],
                ["3 to 5 years", "21 days", "0.875 days"],
                ["6 or more years", "25 days", "about 1.04 days"],
            ],
            "You may carry over up to 5 unused PTO days into the next calendar year. Once your balance "
            "reaches 1.5 times your annual allotment, accrual pauses until you take time off.",
            "Northwind observes 11 paid company holidays: New Year’s Day, Martin Luther King Jr. Day, "
            "Presidents’ Day, Memorial Day, Juneteenth, Independence Day, Labor Day, Thanksgiving, "
            "the day after Thanksgiving, Christmas Eve and Christmas Day. In addition, all offices close "
            "from December 26 through December 31 (“Winter Recharge”); these days do not count "
            "against PTO.",
            "Sick leave is separate from PTO: every employee receives 10 paid sick days per year. No "
            "doctor’s note is required for absences of up to three consecutive days.",
            "Request PTO in PeopleHub. Absences longer than three working days should be requested at "
            "least two weeks in advance.",
        ],
    ),
    (
        "4. Leave Programs",
        [
            "Parental leave: all parents (birth, adoption or foster placement) receive 16 weeks of fully "
            "paid parental leave, to be used within 12 months of the child’s arrival. Leave may be "
            "taken in up to two blocks.",
            "Bereavement leave: 5 paid days for the loss of an immediate family member and 2 paid days "
            "for an extended family member.",
            "Jury duty is fully paid for its whole duration. Each employee also receives 2 paid "
            "volunteer days (16 hours) per calendar year.",
        ],
    ),
    (
        "5. Compensation and Benefits",
        [
            "Paydays are semi-monthly, on the 15th and on the last business day of each month.",
            "401(k) retirement plan: you are eligible from your first day and are auto-enrolled at a 6% "
            "contribution rate, which you can change at any time. Northwind matches 100% of the first "
            "4% of eligible pay you contribute, plus 50% of the next 2%, for a maximum company match of "
            "5% of eligible pay. Matching contributions vest immediately.",
            "Health insurance: Northwind pays 90% of employee premiums and 75% of dependent premiums for "
            "medical, dental and vision coverage. Employees enrolled in the high-deductible health plan "
            "receive an HSA contribution of $1,000 per year (individual coverage) or $2,000 per year "
            "(family coverage).",
            "Learning and development: every employee has a $2,000 annual budget for courses, "
            "conferences, books and certifications. Expenses over $500 need manager approval.",
            "Wellness: a $50 monthly wellness stipend can be used for gym memberships, fitness classes or "
            "mental-health apps.",
            "Equity: restricted stock units (RSUs) vest over four years with a one-year cliff: 25% vests "
            "after 12 months and the rest vests quarterly.",
        ],
    ),
    (
        "6. Travel and Expenses",
        [
            "Book business travel through the Northwind Travel portal. Economy class is required for "
            "flights shorter than 6 hours; premium economy is allowed for flights of 6 hours or longer.",
            "Hotel nightly cap: $250, or $325 in high-cost cities (New York, San Francisco and Boston).",
            "Meals while traveling are reimbursed up to $75 per day. Alcohol is not reimbursable except "
            "at client events approved in advance by a director.",
            "Receipts are required for every expense of $25 or more. Submit expenses in ExpenseHub within "
            "30 days; approved expenses are reimbursed in the next payroll cycle.",
            "Ride-share and taxis are allowed for business travel. Use of a personal car is reimbursed at "
            "the current IRS standard mileage rate for business use.",
        ],
    ),
    (
        "7. Performance and Growth",
        [
            "Performance reviews happen twice a year: a mid-year review in April and an annual review in "
            "October. Promotions are decided in the same two cycles, and compensation changes take "
            "effect on January 1.",
            "Managers hold one-on-one meetings with each direct report at least every two weeks.",
        ],
    ),
    (
        "8. Code of Conduct and Reporting Concerns",
        [
            "We expect everyone to treat colleagues, customers and partners with respect. Harassment and "
            "discrimination are not tolerated.",
            "Report concerns to your manager, to the People team, or anonymously through the ethics "
            "hotline at ethics@northwind.example. Northwind prohibits retaliation against anyone who "
            "raises a concern in good faith.",
            "Information security rules are described in the separate Northwind Information Security "
            "Policy, which every employee must acknowledge each year.",
        ],
    ),
]


def build_handbook_pdf() -> None:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import LETTER
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import inch
    from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    styles = getSampleStyleSheet()
    body = ParagraphStyle("body", parent=styles["BodyText"], fontSize=10.5, leading=15, spaceAfter=7)
    h1 = ParagraphStyle("h1", parent=styles["Heading1"], fontSize=15, spaceBefore=10, spaceAfter=8,
                        textColor=colors.HexColor("#1f3a5f"))
    title = ParagraphStyle("title", parent=styles["Title"], fontSize=26, leading=32,
                           textColor=colors.HexColor("#1f3a5f"))

    def on_page(canvas, doc):  # header + footer on every page
        canvas.saveState()
        canvas.setFont("Helvetica", 8.5)
        canvas.setFillColor(colors.HexColor("#6b7280"))
        canvas.drawString(inch, LETTER[1] - 0.6 * inch, "Northwind Labs — Employee Handbook (2026 edition)")
        canvas.drawRightString(LETTER[0] - inch, 0.6 * inch, f"Page {doc.page}")
        canvas.drawString(inch, 0.6 * inch, "Fictional company created for demo purposes.")
        canvas.restoreState()

    story: list[object] = [
        Spacer(1, 1.6 * inch),
        Paragraph("Northwind Labs", title),
        Paragraph("Employee Handbook — 2026 Edition", styles["Heading2"]),
        Spacer(1, 0.3 * inch),
        Paragraph("Effective January 1, 2026. Applies to full-time employees in the United States.", body),
        Paragraph(
            "<i>Northwind Labs is a fictional company. This document was written for the Document Q&amp;A "
            "Agent demo; any resemblance to a real organization is coincidental.</i>", body),
        PageBreak(),
    ]
    for heading, blocks in HANDBOOK:
        story.append(Paragraph(heading, h1))
        for block in blocks:
            if isinstance(block, list):
                table = Table(block, colWidths=[2.0 * inch, 1.6 * inch, 2.0 * inch])
                table.setStyle(TableStyle([
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1f3a5f")),
                    ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                    ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                    ("FONTSIZE", (0, 0), (-1, -1), 9.5),
                    ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#cbd5e1")),
                    ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f1f5f9")]),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
                ]))
                story += [table, Spacer(1, 10)]
            else:
                story.append(Paragraph(str(block), body))

    doc = SimpleDocTemplate(
        str(OUT / "northwind-employee-handbook.pdf"), pagesize=LETTER,
        title="Northwind Labs Employee Handbook 2026", author="Northwind Labs (fictional)",
        leftMargin=inch, rightMargin=inch, topMargin=inch, bottomMargin=inch,
    )
    doc.build(story, onFirstPage=on_page, onLaterPages=on_page)


# --------------------------------------------------------------------------- #
# Fictional security policy (DOCX)
# --------------------------------------------------------------------------- #
SECURITY_POLICY: list[tuple[str, list[str]]] = [
    ("1. Purpose and scope", [
        "This policy protects Northwind Labs’ systems, customer data and employees. It applies to every "
        "employee, contractor and intern, on any device used for Northwind work. Version 3.2, effective "
        "March 1, 2026. Owner: Security team (security@northwind.example).",
    ]),
    ("2. Accounts and authentication", [
        "Multi-factor authentication (MFA) is required on every company system. Administrators and anyone "
        "with production access must use a FIDO2 hardware security key.",
        "Passwords must be at least 14 characters long and stored in VaultKey, the company password "
        "manager. Never reuse a password across systems. Passwords are changed only when a compromise is "
        "suspected, not on a fixed schedule.",
        "Access rights are reviewed every quarter. When someone leaves Northwind, all of their access is "
        "revoked within 4 hours.",
    ]),
    ("3. Devices", [
        "Company laptops must use full-disk encryption and lock automatically after 5 minutes of "
        "inactivity. Laptops are refreshed every three years.",
        "Operating-system updates must be installed within 14 days of release; updates marked critical "
        "must be installed within 72 hours.",
        "Report a lost or stolen device to the Security team within 1 hour so it can be wiped remotely.",
    ]),
    ("4. Data classification", [
        "Public: may be shared freely (for example, published blog posts).",
        "Internal: for employees only (for example, this policy and team plans).",
        "Confidential: limited to people who need it (for example, financial results before release).",
        "Restricted: the most sensitive data, such as customer personal data, credentials and encryption "
        "keys. Restricted data must never be stored on personal devices or pasted into AI tools that are "
        "not on the approved list.",
    ]),
    ("5. AI tools", [
        "Only AI assistants on the Security team’s approved list may be used with Internal or "
        "Confidential data, and no AI tool may receive Restricted data. Code produced with AI assistance "
        "must go through normal code review before it is merged.",
    ]),
    ("6. Phishing and incident response", [
        "Report suspicious emails with the “Report Phish” button or forward them to "
        "security@northwind.example within 1 hour. Never enter your credentials on a page opened from an "
        "email link.",
        "Report any suspected security incident in the #sec-incidents channel or to the security on-call "
        "engineer within 30 minutes of discovery. Incidents are classified SEV1 to SEV3; the on-call "
        "engineer responds to a SEV1 within 15 minutes, at any hour.",
    ]),
]


def build_security_docx() -> None:
    import docx

    d = docx.Document()
    d.core_properties.title = "Northwind Labs Information Security Policy"
    d.add_heading("Northwind Labs — Information Security Policy", level=0)
    d.add_paragraph("Fictional company created for the Document Q&A Agent demo.").italic = True
    for heading, paragraphs in SECURITY_POLICY:
        d.add_heading(heading, level=1)
        for p in paragraphs:
            d.add_paragraph(p)
    d.save(str(OUT / "northwind-security-policy.docx"))


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "pep-0008-style-guide.rst").write_text(fetch(PEP8_URL), encoding="utf-8")
    build_mcp_spec()
    build_handbook_pdf()
    build_security_docx()
    for f in sorted(OUT.iterdir()):
        print(f"{f.name:40s} {f.stat().st_size / 1024:8.1f} KB")


if __name__ == "__main__":
    main()
