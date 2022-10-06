require('dotenv').config();

const puppeteer = require('puppeteer');

Date.prototype.addDays = function(days) {
    var date = new Date(this.valueOf());
    date.setDate(date.getDate() + days);
    return date;
};

const padTo2Digits = (num) => {
    return num.toString().padStart(2, '0');
};

const formatDate = (date) => {
    return [
      padTo2Digits(date.getMonth() + 1),
      padTo2Digits(date.getDate()),
      date.getFullYear().toString().slice(2),
    ].join('/');
};

const pause = async (seconds) => {
    return new Promise((resolve, reject) => {
        setTimeout(() => {
            resolve();
        }, seconds*1000);
    });
};

/**Log in to MyFBO.
 * @param {puppeteer.Page} page 
 */
const logIn = async (page) => {
    try{
        console.log('Attempting to log in.');
        await page.goto(process.env.WNCAS_URL);
        await page.waitForSelector('frame[id="myfbo2"]');
        let loginFrame = await (await page.$('frame[id="myfbo2"]')).contentFrame();
        await loginFrame.waitForSelector('input[name="email"]');
        let inputEmail = await loginFrame.$('input[name="email"]');
        let inputPassword = await loginFrame.$('input[name="password"]');
        let btnLogIn = await loginFrame.$('input[name="gogo"]');
        await inputEmail.type(process.env.WNCAS_USER);
        await inputPassword.type(process.env.WNCAS_PASS);
        await btnLogIn.click();
    } catch (loginErr){
        console.error('Unable to log in');
        throw(loginErr);
    }
};

/**Navigate to daily schedule.
 * @param {puppeteer.Page} page Chromium page.
 * @returns {Promise<puppeteer.Frame>} Schedule element.
 */
const goToDailyDetail = async (page) => {
    try{
        console.log('Navigating to Daily Detail page.');
        let frame = await (await page.$('frame[id="myfbo2"]')).contentFrame();
        await frame.waitForSelector('frame[name="ctf"]');
        let navFrame = await (await frame.$('frame[name="ctf"]')).contentFrame();
        await navFrame.waitForSelector('td[id="Schedule"]');
        let scheduleNav = await navFrame.$('td[id="Schedule"]');
        await scheduleNav.click();
        await frame.waitForSelector('frame[name="cmain"]');
        let mainFrame = await (await frame.$('frame[name="cmain"]')).contentFrame();
        await mainFrame.waitForSelector('#mainbody div fieldset:nth-child(3) div button:nth-child(4)');
        let ddButton = await mainFrame.$('#mainbody div fieldset:nth-child(3) div button:nth-child(4)');
        await ddButton.click();
        await mainFrame.waitForSelector('#mainbody table[style*="border-bottom"]');
        return mainFrame;
    } catch (scheduleErr) {
        console.error('Unable to navigate to Daily Detail frame.');
        throw(scheduleErr);
    }
};

/**Navigate to a particular day within the daily detail screen.
 * @param {puppeteer.Frame} frame Frame containing daily detail screen.
 * @param {Date} date Date object of target day.
 * @returns {Promise<puppeteer.Frame>} Schedule element.
 */
const goToDay = async (frame, date) => {
    let day = formatDate(date);
    await frame.waitForSelector('#mainbody form[style*="margin-bottom: 9px"] input[value*="Next"]');
    console.log(`Navigating to schedule for ${day}.`);
    let btnNext = await frame.$('#mainbody form[style*="margin-bottom: 9px"] input[value*="Next"]');
    let outerHTML = await (await btnNext.getProperty('outerHTML')).jsonValue();
    let listDateRgx = /list_date=\d{1,2}\/\d{1,2}\/\d{1,4}&/;
    let replacedDate = outerHTML.replace(listDateRgx, `list_date=${day}&`);
    replacedDate = replacedDate.replace('thisfmt=V', 'thisfmt=H');
    await frame.evaluate((newOuter) => {
        document.querySelector('#mainbody form[style*="margin-bottom: 9px"] input[value*="Next"]')
            .outerHTML = newOuter;
    }, replacedDate);
    btnNext = await frame.$('#mainbody form[style*="margin-bottom: 9px"] input[value*="Next"]');
    await pause(0.1);
    await btnNext.click();
    await frame.waitForNavigation();
    await frame.waitForSelector('#mainbody form span.ph');
    let tableTitle = await frame.$('#mainbody form span.ph');
    let title = await (await tableTitle.getProperty('textContent')).jsonValue();
    if(title.indexOf('Daily') < 0) throw new Error('Not on Daily Schedule page.');
    if(title.indexOf('Schedule') < 0) throw new Error('Not on Daily Schedule page.');
    if(title.indexOf(day) < 0) {
        console.error(title);
        throw new Error('Daily Schedule on incorrect date.');
    }
    return frame;
};

/**Parse the daily schedule.
 * @param {puppeteer.Frame} frame Frame containing daily detail screen.
 * @returns {Promise<{
 *  cfis: {
 *   name: string,
 *   availableSlots: number[]
 *  }[],
 *  planes: {
 *   name: string,
 *   availableSlots: number[]
 *  }[],
 *  timeSlots: string[]
 * }>}
 */
const scrapeDay = async (frame) => {
    console.log('Scraping schedule.');
    let table = await frame.$('#mainbody table[style*="border-bottom"]');
    let rows = await table.$$('tr');
    let timeSlots = [];
    let timeSlotElements = await rows[1].$$('td');
    for (let i = 0; i < timeSlotElements.length; i++) {
        const timeSlotElement = timeSlotElements[i];
        let time = (await (await timeSlotElement.getProperty('textContent')).jsonValue()).trim();
        timeSlots.push(time);
    }

    let cfis = [];
    let planes = [];
    for (let i = 2; i < rows.length; i++) {
        const row = rows[i];
        let nameCell = await row.$('td');
        let name = (await (await nameCell.getProperty('textContent')).jsonValue())
            .trim()
            .replace(/\s/g, ' ');
        let isCfi = process.env.WNCAS_CFIS.split('|').includes(name);
        let isPlane = process.env.WNCAS_PLANES.split('|').includes(name);
        if(!isCfi && !isPlane){
            //console.log(`Encountered unknown entity "${name}".`);
            continue;
        }
        let availability = [];
        let entityTimeSlotElements = await row.$$('td');
        let timeCol = 0;
        for (let j = 1; j < entityTimeSlotElements.length; j++) {
            const entityTimeSlotElement = entityTimeSlotElements[j];
            let classes = (await (await entityTimeSlotElement.getProperty('className')).jsonValue()).trim();
            let colspan = await (await entityTimeSlotElement.getProperty('colSpan')).jsonValue();
            if(classes.includes('chair')){
                availability.push(timeCol);
            }
            timeCol += colspan;
        }

        if (isCfi){
            cfis.push({
                name: name,
                availableSlots: availability
            });
        }

        if (isPlane){
            planes.push({
                name: name,
                availableSlots: availability
            });
        }
    }

    return {
        cfis: cfis,
        planes: planes,
        timeSlots: timeSlots
    };
};

/**
 * @param {number[]} a Sorted array of integers.
 * @returns {number[][]}
 */
const getAdjacentNumbers = (a) => {
    return a.reduce((r,n) => {
        const lastSubArray = r[r.length - 1];
        if(!lastSubArray || lastSubArray[lastSubArray.length - 1] !== n - 1) {
            r.push([]);
        }
        r[r.length - 1].push(n);
        return r;
    }, []);
};

/**
 * 
 * @param {{
 *  day: Date,
 *  schedule: {
 *   cfis: {
 *    name: string,
 *    availableSlots: number[]
 *   }[],
 *   planes: {
 *    name: string,
 *    availableSlots: number[]
 *   }[],
 *   timeSlots: string[]
 *  }
 * }[]} schedules Schedules.
 * @returns {{
 *  day: Date,
 *  blocks: string[],
 *  cfi: string,
 *  plane: string,
 *  sharedBlocks: number[]
 * }[]}
 */
const findIntersectingAvailability = (schedules) => {
    let result = [];
    for (let i = 0; i < schedules.length; i++) {
        const today = schedules[i];
        for (let cfiI = 0; cfiI < today.schedule.cfis.length; cfiI++) {
            const cfi = today.schedule.cfis[cfiI];
            for (let planeI = 0; planeI < today.schedule.planes.length; planeI++) {
                const plane = today.schedule.planes[planeI];
                const intersection = cfi.availableSlots.filter(a => plane.availableSlots.includes(a));
                if(intersection.length < 1) continue;
                result.push({
                    day: today.day,
                    blocks: today.schedule.timeSlots,
                    cfi: cfi.name,
                    plane: plane.name,
                    sharedBlocks: intersection
                });
                // console.log(`${cfi.name} and ${plane.name} are both available ${formatDate(today.day)} at`, intersection);
                // let bb = getAdjacentNumbers(intersection);
                // console.log(bb);
            }
        }
    }
    return result;
};

/**
 * 
 * @param {{
 *  day: Date,
 *  blocks: string[],
 *  cfi: string,
 *  plane: string,
 *  sharedBlocks: number[]
 * }[]} intersections 
 * @param {number} minBlocks 
 */
const reportIntersections = (intersections, minBlocks) => {
    for (let i = 0; i < intersections.length; i++) {
        const intersection = intersections[i];
        const sharedAdjacentBlocks = getAdjacentNumbers(intersection.sharedBlocks);
        for (let sabI = 0; sabI < sharedAdjacentBlocks.length; sabI++) {
            const timeChunk = sharedAdjacentBlocks[sabI];
            if(timeChunk.length < minBlocks) continue;
            let reportString = `${intersection.cfi} and ${intersection.plane} are both available`;
            reportString += ` ${formatDate(intersection.day)} from blocks `;
            reportString += intersection.blocks[timeChunk[0]] + ' through ';
            reportString += intersection.blocks[timeChunk[timeChunk.length-1]];
            console.log(reportString);
        }
    }
};

const main = async () => {
    const daysToCheck = parseInt(process.env.WNCAS_DAYS);
    const startDate = (new Date()).addDays(parseInt(process.env.WNCAS_START_OFFSET));

    const browserOptions = {
        headless: false
    };
    const browser = await puppeteer.launch(browserOptions);
    const page = await browser.newPage();
    await logIn(page);
    let scheduleFrame = await goToDailyDetail(page);
    let schedules = [];

    for (let i = 1; i <= daysToCheck; i++) {
        const checkDay = startDate.addDays(i);
        await goToDay(scheduleFrame, checkDay);
        let schedule = await scrapeDay(scheduleFrame);
        schedules.push({
            day: checkDay,
            schedule: schedule
        });
    }

    await browser.close();

    let intersections = findIntersectingAvailability(schedules);
    reportIntersections(intersections, parseInt(process.env.WNCAS_MIN_BLOCKS));

    console.log('-- THE END --');
};

main();