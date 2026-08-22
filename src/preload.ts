export function preLoadCheck(){
    //Add beforeunload event listener to prevent the user from leaving the page
    window.addEventListener('beforeunload', (e) => {
        e.preventDefault()
        //legacy browser
        e.returnValue = true
    })

    return true;
}
