// Phantombuster configuration {
"phantombuster command: nodejs"
"phantombuster package: 5"
"phantombuster dependencies: lib-StoreUtilities.js, lib-LinkedIn.js, lib-LinkedInScraper.js"

const fs = require("fs")
const Papa = require("papaparse")
const needle = require("needle")

const Buster = require("phantombuster")
const buster = new Buster()

const Nick = require("nickjs")
const nick = new Nick({
	loadImages: true,
	printPageErrors: false,
	printResourceErrors: false,
	printNavigation: false,
	printAborts: false,
	debug: false,
})

const StoreUtilities = require("./lib-StoreUtilities")
const utils = new StoreUtilities(nick, buster)
const LinkedIn = require("./lib-LinkedIn")
const linkedIn = new LinkedIn(nick, buster, utils)
const LinkedInScraper = require("./lib-LinkedInScraper")

const DB_NAME = "result"
const MAX_SKILLS = 6
// }

const getDB = async () => {
	const resp = await needle("get", `https://phantombuster.com/api/v1/agent/${buster.agentId}`, {}, { headers: {
		"X-Phantombuster-Key-1": buster.apiKey }
	})
	if (resp.body && resp.body.status === "success" && resp.body.data.awsFolder && resp.body.data.userAwsFolder) {
		const url = `https://phantombuster.s3.amazonaws.com/${resp.body.data.userAwsFolder}/${resp.body.data.awsFolder}/${DB_NAME}.csv`
		try {
			await buster.download(url, `${DB_NAME}.csv`)
			const file = fs.readFileSync(`${DB_NAME}.csv`, "UTF-8")
			const data = Papa.parse(file, { header: true }).data
			return data
		} catch (err) {
			return []
		}
	} else {
		throw "Could not load database of already scraped profiles."
	}
}

const getUrlsToScrape = (data, numberOfAddsPerLaunch) => {
	data = data.filter((item, pos) => data.indexOf(item) === pos)
	let i = 0
	const maxLength = data.length
	const urls = []
	if (maxLength === 0) {
		utils.log("Input spreadsheet is empty OR we already scraped all the profiles from this spreadsheet.", "warning")
		nick.exit()
	}

	while (i < numberOfAddsPerLaunch && i < maxLength) {
		const row = Math.floor(Math.random() * data.length)
		urls.push(data[row].trim())
		data.splice(row, 1)
		i++
	}

	return urls
}

const filterRows = (str, db) => {
	for (const line of db) {
		const regex = new RegExp(`/in/${line.profileId}($|/)`)
		if (str.match(regex) || (str === line.baseUrl)) {
			return false
		}
	}
	return true
}

/**
 * @todo Use this function when others validations in this API are done
 * @description Tiny function used to return as much as possible skills from a lib-LinkedInScraper JSON result
 * @param {Object} infos -- Result object formatted for the JSON output
 * @param {Number} [skillsToRet] -- Count of skills to return
 * @return {Object} CSV object with the count of skills asked
 */
const _craftCsv = (infos, skillsToRet = MAX_SKILLS) => {
	let job = {}
	let ret = {}

	if (infos.jobs && infos.jobs[0]) {
		job = infos.jobs[0]
	}

	const hasDetails = infos.hasOwnProperty("details")
	const hasGeneral = infos.hasOwnProperty("general")

	/**
	 * HACK: this function use the same code from craftCsvObject from lib-LinkedInScraper
	 * but it will return if possible skillsToRet count skills (default 6)
	 */

	ret = {
		linkedinProfile: (hasDetails) ? (infos.details.linkedinProfile || null) : null,
		description: (hasGeneral) ? (infos.general.description || null) : null,
		imgUrl: (hasGeneral) ? (infos.general.imgUrl || null) : null,
		firstName: (hasGeneral) ? (infos.general.firstName || null) : null,
		lastName: (hasGeneral) ? (infos.general.lastName || null) : null,
		fullName: (hasGeneral) ? (infos.general.fullName || null) : null,
		subscribers: (hasGeneral) ? (infos.general.subscribers || null) : null,
		company: job.companyName || null,
		companyUrl: job.companyUrl || null,
		jobTitle: job.jobTitle || null,
		jobDescription: job.description || null,
		location: job.location || null,
		mail: (hasDetails) ? (infos.details.mail || null) : null,
		mailFromHunter: (hasDetails) ? (infos.details.mailFromHunter || null) : null,
		phoneNumber: (hasDetails) ? (infos.details.phone || null) : null,
		twitter: (hasDetails) ? (infos.details.twitter || null) : null,
	}

	if (infos.skills.length > 0) {
		for (let i = 0; i < skillsToRet; i++) {
			if (i > infos.skills.length) {
				break
			}
			ret[`skill${i+1}`] = infos.skills[i].name
			ret[`endorsement${i+1}`] = infos.skills[i].endorsements
		}
	}

	return ret
}

const getFieldsFromArray = (arr) => {
	const fields = []
	for (const line of arr) {
		if (line && (typeof(line) == 'object')) {
			for (const field of Object.keys(line)) {
				if (fields.indexOf(field) < 0) {
					fields.push(field)
				}
			}
		}
	}
	return fields
}

// Main function that execute all the steps to launch the scrape and handle errors
;(async () => {
	let {sessionCookie, profileUrls, spreadsheetUrl, columnName, hunterApiKey, numberOfAddsPerLaunch, noDatabase} = utils.validateArguments()
	let urls = profileUrls
	if (spreadsheetUrl) {
		urls = await utils.getDataFromCsv(spreadsheetUrl, columnName)
	}

	if (!numberOfAddsPerLaunch) {
		numberOfAddsPerLaunch = urls.length
	} else if (numberOfAddsPerLaunch > urls.length) {
		numberOfAddsPerLaunch = urls.length
	}

	const db = noDatabase ? [] : await getDB()

	urls = getUrlsToScrape(urls.filter(el => filterRows(el, db)), numberOfAddsPerLaunch)
	console.log(`URLs to scrape: ${JSON.stringify(urls, undefined, 4)}`)

	const linkedInScraper = new LinkedInScraper(utils, hunterApiKey, nick)
	const tab = await nick.newTab()
	await linkedIn.login(tab, sessionCookie)

	const result = []
	for (const url of urls) {
		const timeLeft = await utils.checkTimeLeft()
		if (!timeLeft.timeLeft) {
			utils.log(`Scraping stopped: ${timeLeft.message}`, "warning")
			break
		}
		try {
			utils.log(`Opening page ${url}`, "loading")
			const infos = await linkedInScraper.scrapeProfile(tab, url)
			/**
			 * NOTE: the csv output from the lib is no more used in this API,
			 * since the issue #40 require to give more than 3 skills & their endorsements count
			 * the lib still return the "basic" csv output
			 */
			const craftedCsv = _craftCsv(infos.json)
			craftedCsv.baseUrl = url
			craftedCsv.profileId = linkedIn.getUsername(await tab.getUrl())
			db.push(craftedCsv)
			result.push(infos.json)
		} catch (err) {
			utils.log(`Can't scrape the profile at ${url} due to: ${err.message || err}`, "warning")
			continue
		}
	}

	await linkedIn.saveCookie()
	try {
		await buster.setResultObject(result)
	} catch (e) {
		utils.log(`Could not save result object: ${e.message || e}`, "warning")
	}
	if (noDatabase) {
		nick.exit()
	} else {
		await utils.saveResult(db, DB_NAME, getFieldsFromArray(db)) // deprecated call :(
	}
})()
.catch(err => {
	utils.log(err, "error")
	nick.exit(1)
})
