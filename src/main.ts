let startTime = Number(process.env.HAL_STARTUP_TIMESTAMP) || Date.now()
let now = Date.now()
console.log(`Hal: started in ${now - startTime} ms`)
