const fs = require("fs");
const express = require("express");
const cors = require("cors");
const scrapingbee = require("scrapingbee");

const app = express();
const port = 3000;

const Pool = require("pg").Pool;

app.use(cors());
app.use(express.json());

const pool = new Pool({
  user: process.env.DB_USERNAME,
  passwoord: process.env.DB_PASSWORD,
  host: "localhost",
  port: 5432,
  database: "Scraper_POC",
});

const searchParams = {
  extract_rules: {
    links: {
      selector: "a.listingCard-globalLink",
      type: "list",
      output: "@href",
    },
    addresses: {
      selector: ".listingCard-link",
      type: "list",
      output: "text",
    },
    listed_by: { selector: ".listingCardBottom--finePrint", type: "list" },
  },
  wait_for: ".jsGlobalListingCardLink",
};

const apartmentParams = {
  extract_rules: {
    title: ".building-title",
    price: { selector: ".price ", output: "text" },
    popularity: { selector: ".popularity", output: "text" },
    description: "#full-content",
    no_fee: ".NoFeeBadge",
    price_history: {
      selector: ".Table-cell--priceHistory",
      type: "list",
      output: "text",
    },
    listing_company: { selector: ".ListingAgents-agentName", output: "text" },
    days_on_mkt: { selector: ".Vitals-data", type: "list", output: "text" },
    amenities: ".AmenitiesBlock",
    vitalInfo: { selector: ".detail_cell", type: "list", output: "text" },
  },
};

const writeToFile = async (content) => {
  fs.appendFile(
    "/Users/mmarillo/Desktop/sandbox/scraper_api_poc/database.txt",
    JSON.stringify(content),
    (err) => {
      if (err) {
        console.error(err);
      }
      // file written successfully
    }
  );
};

const postAnApartment = async (apartment) => {
  try {
    const newApartment = await pool.query(
      "INSERT INTO apartment (address, apartment_number, bedrooms, bathrooms, square_feet, description, listing_company, no_fee) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
      [
        apartment.address,
        apartment.apartment,
        apartment.bedrooms,
        apartment.bathrooms,
        apartment.sqFt,
        apartment.description,
        apartment.listingCompany,
        apartment.noFee,
      ]
    );
    return newApartment.rows[0];
  } catch (err) {
    console.error(err);
  }
};

const formatApartment = async (apartment) => {
  let formattedApartment = {};
  let address = apartment.title?.split("#");
  let price = parseInt(apartment.price?.replace(/\D/g, ""), 10); // strip non numbers, turn to integer
  let popularity = parseInt(apartment.popularity?.replace(/\D/g, ""), 10); // just give me the numbers
  let isNoFee = !!apartment.no_fee;
  let daysOnMarket = apartment.days_on_mkt;
  let importantFacts = apartment.vitalInfo;
  formattedApartment.address = address[0].trim();
  formattedApartment.apartment = address[1];
  formattedApartment.price = price;
  formattedApartment.noFee = isNoFee;
  formattedApartment.listingCompany = apartment.listing_company;
  formattedApartment.daysOnMarket = daysOnMarket[1];
  formattedApartment.popularity = popularity || "";
  formattedApartment.description = apartment.description || "";
  formattedApartment.bedrooms = importantFacts
    .find((string) => string.includes("bed"))
    ?.split(" ")[0];
  formattedApartment.bathrooms = importantFacts
    .find((string) => string.includes("bath"))
    ?.split(" ")[0];
  formattedApartment.sqFt = importantFacts.find((string) =>
    string.includes("ft")
  );
  writeToFile(formattedApartment);
  const returnedApt = await postAnApartment(formattedApartment);
  console.log(returnedApt);
  return formattedApartment;
};

async function get(url, params) {
  const client = new scrapingbee.ScrapingBeeClient(
    process.env.SCRAPINGBEE_API_KEY
  );
  const response = await client.get({
    url: url,
    params: params,
  });
  return response;
}

app.get("/", (req, res) => {
  res.send("Hello!");
});

app.get("/searches", async (req, res) => {
  try {
    const allSearches = await pool.query("SELECT * FROM search");
    res.json(allSearches.rows);
  } catch (err) {
    console.error(err.message);
  }
});

app.get("/apartments", async (req, res) => {
  try {
    const allApartments = await pool.query("SELECT * FROM apartment");
    res.json(allApartments.rows);
  } catch (err) {
    console.error(err.message);
  }
});

app.get("/apartments/:address/:apartmentNumber", async (req, res) => {
  try {
    const allApartments = await pool.query("SELECT * FROM apartment");
    const reqAddress = req.path
      .split("/")[2]
      .split("-")
      .join(" ")
      .toLowerCase();
    const reqApartment = req.path.split("/")[3];
    const thisApartment = allApartments.rows.find(
      (apartment) =>
        apartment.address.toLowerCase() === reqAddress &&
        apartment.apartment_number === reqApartment
    );
    return thisApartment || undefined;
  } catch (err) {
    console.error(err);
  }
});

app.post("/search", async (req, res) => {
  console.log(req.body);
  const decoder = new TextDecoder();
  let searchFrontPage = await get(
    `https://streeteasy.com/${req.body.bedrooms}-bedroom-apartments-for-rent/${req.body.location}/price:${req.body.minPrice}-${req.body.maxPrice}`,
    searchParams
  );
  const text = decoder.decode(searchFrontPage.data);
  const linksAndListingCompanies = JSON.parse(text);
  console.log(linksAndListingCompanies);
  let thisSearch = {};
  thisSearch.highestRank = 0; //if not found, set as 0
  linksAndListingCompanies.links.splice(0, 2); //remove first two links, they're featured
  linksAndListingCompanies.listed_by.splice(0, 2); // remove first two listing companies, they're featured
  for (let i = 0; i < linksAndListingCompanies.links.length; i++) {
    // go backwards thru list of apts, if one of them is an SP building, set it as the highest rank
    if (
      linksAndListingCompanies.listed_by[i].includes("Silverstein") &&
      thisSearch.highestRank === 0
    ) {
      // 0 is not listed, 1 is best, etc
      thisSearch.highestRank = i + 1;
    }
  }
  thisSearch.apartments = linksAndListingCompanies.links;
  let listOfUrls = linksAndListingCompanies.links;
  let rentalAverage = 0;
  try {
    for (let i = 0; i < listOfUrls.length; i++) {
      let thisApt = await get(listOfUrls[i], apartmentParams);
      let aptText = decoder.decode(thisApt.data);
      let results = JSON.parse(aptText);
      let returnValue = await formatApartment(results);
      rentalAverage += returnValue.price;
    }
  } catch (err) {
    console.log(err);
  }
  today = new Date();
  thisSearch.createdAt = today;
  thisSearch.averageRent = Math.round(rentalAverage / listOfUrls.length + 1);
  writeToFile(thisSearch);
  console.log("finito ->", thisSearch);
  res.send("all done!");
});

app.listen(port, () => console.log(`scraper POC listening on port ${port}!`));
