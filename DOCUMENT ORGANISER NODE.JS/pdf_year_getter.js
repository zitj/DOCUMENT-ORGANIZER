const fs = require("fs");
const pdfParse = require("pdf-parse");

async function getDateFromPDF(fullFilePath, pdfType) {
    const buffer = fs.readFileSync(fullFilePath);
    const data = await pdfParse(buffer);

    // Plain text of the PDF
    const text = data.text;

    let dateMatch;
    if (pdfType === "dinarski") {
        // Dinarski: look after "Dinarsko knjigovodstvo"
        const m = /Dinarsko knjigovodstvo[\s\S]*?(\d{2}\.\d{2}\.\d{4})/m.exec(
            text
        );
        if (m) dateMatch = m[1];
    } else if (pdfType === "devizni") {
        // Devizni: look after "Devizno knjigovodstvo"
        const m = /Devizno knjigovodstvo[\s\S]*?(\d{2}\.\d{2}\.\d{4})/m.exec(
            text
        );
        if (m) dateMatch = m[1];
    } else {
        throw new Error(`Unknown pdfType: ${pdfType}`);
    }

    if (!dateMatch) {
        throw new Error(
            `Could not find statement date for pdfType="${pdfType}"`
        );
    }

    const [day, month, year] = dateMatch.split(".");
    return { day, month, year };
}

// Example usage:
module.exports = {
    getDateFromPDF,
};
