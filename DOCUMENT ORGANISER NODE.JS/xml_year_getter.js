const fs = require("fs");
const { DOMParser } = require("@xmldom/xmldom");
const xpath = require("xpath");

function getDateFromXML(fullFilePath) {
    const xml = fs.readFileSync(fullFilePath, "utf8");
    const doc = new DOMParser().parseFromString(xml);
    const nodes = xpath.select("//Zaglavlje/@DatumIzvoda", doc);
    const date = nodes.length ? nodes[0].value : null;
    const [day, month, year] = date.split(".");
    return { day, month, year };
}

module.exports = {
    getDateFromXML,
};
