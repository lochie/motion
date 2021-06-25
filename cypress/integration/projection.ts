Cypress.config({
    baseUrl: "http://0.0.0.0:8000/dev/projection/",
})

describe("Project the element to its original box", () => {
    const tests = require("../fixtures/projection-tests.json")

    tests.forEach((test) => {
        it(test, () => {
            cy.visit(test)
            cy.get('[data-layout-correct="false"]').should("not.exist")
        })
    })
})