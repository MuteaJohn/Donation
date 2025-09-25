// We start by importing the necessary libraries.
// `express` is a web framework for Node.js that simplifies building web servers.
const express = require("express");

const paypal = require("@paypal/paypal-server-sdk");
// `cors` is a middleware that allows our server to accept requests from different origins (e.g., your website).
const cors = require("cors");
// `dotenv` loads environment variables from a .env file, keeping sensitive data out of our code.
require("dotenv").config();

// We create an instance of the Express application.
const app = express();
// We define the port number where our server will listen for requests.
const port = 3000;

// We apply the `cors` middleware to our app to handle cross-origin requests.
app.use(cors());
// We apply Express's built-in middleware to parse incoming JSON request bodies.
app.use(express.json());

// This is a simple, temporary object to store transaction details in memory.
// In a real application, you would use a database like MongoDB or Firestore.
const transactions = {};

// We retrieve our M-Pesa credentials and API endpoints from the environment variables,
// which are loaded from our .env file.
const M_PESA_API_URL = process.env.M_PESA_API_URL;
const M_PESA_AUTH_URL = process.env.M_PESA_AUTH_URL;
const CONSUMER_KEY = process.env.CONSUMER_KEY;
const CONSUMER_SECRET = process.env.CONSUMER_SECRET;
const SHORTCODE = process.env.SHORTCODE;
const PASSKEY = process.env.PASSKEY;
const CALLBACK_URL = process.env.CALLBACK_URL;

//==PAYPAL CODE ==
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;

//We create a new PayPal environment object, sandbox for testing
const environment = new paypal.core.SandboxEnvironment(
  PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET
);
//We create a new paypal client to with the API
const client = new paypal.core.PayPalHttpClient(environment);

// This function is responsible for authenticating with the M-Pesa API and getting a security token.
const getAccessToken = async () => {
  try {
    // We combine the consumer key and secret and encode them in Base64 format, as required by the M-Pesa API.
    const auth = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString(
      "base64"
    );
    // We send a GET request to the M-Pesa authentication URL.
    const response = await fetch(M_PESA_AUTH_URL, {
      // We include the Base64-encoded credentials in the request header for authentication.
      headers: {
        Authorization: `Basic ${auth}`,
      },
    });

    // If the response is not OK (e.g., status code 401 Unauthorized), we throw an error.
    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }
    // We parse the JSON response and extract the access token.
    const data = await response.json();
    return data.access_token;
  } catch (error) {
    // If any error occurs during the process, we log it and throw a new, more descriptive error.
    console.error("Error getting M-pesa access token:", error.message);
    throw new Error("Failed to get M-pesa access token.");
  }
};

// This is the endpoint that receives the STK Push request from the website's front-end.
app.post("/stk-push", async (req, res) => {
  // We extract the 'phone' and 'amount' from the JSON body of the request.
  const { phone, amount } = req.body;
  // We generate a unique transaction ID to track this specific request.
  const transactionId =
    Math.random().toString(36).substring(2, 15) +
    Math.random().toString(36).substring(2, 15);

  // We store the transaction details in our temporary object.
  transactions[transactionId] = {
    phone,
    amount,
    status: "pending",
    payment_id: null,
  };

  // We create a timestamp in the specific format required by the M-Pesa API (YYYYMMDDHHmmss).
  const timestamp = new Date()
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, -3);
  // We create a password by concatenating the shortcode, passkey, and timestamp, then encoding the result in Base64.
  const password = Buffer.from(`${SHORTCODE}${PASSKEY}${timestamp}`).toString(
    "base64"
  );

  // This object contains all the required parameters for the STK Push API call.
  const requestBody = {
    BusinessShortCode: SHORTCODE, // The business number.
    Password: password, // The unique, secure password.
    Timestamp: timestamp, // The formatted timestamp.
    TransactionType: "CustomerPayBillOnline", // The type of transaction.
    Amount: amount, // The amount of money to be donated.
    PartyA: phone, // The payer's phone number.
    PartyB: SHORTCODE, // The recipient's shortcode.
    PhoneNumber: phone, // The phone number for the STK Push notification.
    CallBackURL: CALLBACK_URL, // The URL where M-Pesa will send the transaction result.
    AccountReference: "Donation", // A custom reference for the transaction.
    TransactionDesc: "Donation", // A short description.
  };

  try {
    // We call our `getAccessToken` function to get the security token.
    const token = await getAccessToken();
    // We send a POST request to the M-Pesa STK Push API with the transaction details.
    const apiResponse = await fetch(M_PESA_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`, // We include the access token here.
      },
      body: JSON.stringify(requestBody), // We send the request body as a JSON string.
    });

    const data = await apiResponse.json();

    // If the API response is not OK, we log the error details and throw an error.
    if (!apiResponse.ok) {
      console.error("STK Push API Error:", data);
      throw new Error(data.errorMessage || "Failed to initiate STK Push.");
    }

    // If the call is successful, we store the M-Pesa-provided payment ID in our transaction record.
    transactions[transactionId].payment_id = data.CheckoutRequestID;
    // We send a success message back to the front-end with the unique transaction ID.
    res.json({
      message: "STK Push initiated successfully.",
      transactionId: transactionId,
      response: data,
    });
  } catch (error) {
    // If any error occurs, we log it and send a 500 status code with an error message to the front-end.
    console.error("STK Push Error:", error.message);
    if (transactions[transactionId]) {
      transactions[transactionId].status = "failed";
    }
    res
      .status(500)
      .json({ error: error.message || "Failed to initiate STK Push." });
  }
});

// This is the endpoint that M-Pesa calls back to after the user completes the transaction.
app.post("/stk-callback", (req, res) => {
  // We extract the callback data from the M-Pesa request body.
  const callbackData = req.body.Body.stkCallback;
  console.log("Received M-pesa Callback:", callbackData);

  // We get the payment ID and the result code from the callback data.
  const checkoutRequestId = callbackData.CheckoutRequestID;
  const resultCode = callbackData.ResultCode;

  // We find the matching transaction in our temporary storage using the payment ID.
  const localTransactionId = Object.keys(transactions).find(
    (key) => transactions[key].payment_id === checkoutRequestId
  );

  // If a matching transaction is found...
  if (localTransactionId) {
    // We update the transaction status based on the result code (0 means success).
    if (resultCode === 0) {
      transactions[localTransactionId].status = "success";
      console.log(`Transaction ${localTransactionId} was successful.`);
    } else {
      transactions[localTransactionId].status = "failed";
      console.log(`Transaction ${localTransactionId} failed.`);
    }
  } else {
    // If no matching transaction is found, we log a warning.
    console.log(
      "Could not find a matching local transaction for CheckoutRequestID:",
      checkoutRequestId
    );
  }

  // We send a successful response back to M-Pesa to acknowledge we received the callback.
  res.status(200).send("Callback received successfully.");
});

// This is the endpoint that the website's front-end uses to check the status of a transaction.
app.get("/transaction-status/:transactionId", (req, res) => {
  // We get the transaction ID from the URL parameters.
  const { transactionId } = req.params;
  // We look up the transaction in our temporary storage.
  const transaction = transactions[transactionId];

  // If the transaction is found, we send its current status back to the front-end.
  if (transaction) {
    res.json({ status: transaction.status });
  } else {
    // If it's not found, we send a 404 Not Found error.
    res.status(404).json({ error: "Transaction not found." });
  }
});

//START NEW PAYPAL ROUTES
//This is the frontend calls to create a PayPal order
app.post("/create-paypal-order", async (req, res) => {
  //We get the amount from the frontend request body
  const { amount } = req.body;
  //We create JSON  body for the PayPal API req
  const requestBody = {
    intent: "CAPTURE", // This means we want to capture the payment immediately.
    purchase_units: [
      {
        amount: {
          currency_code: "USD",// PayPal requires a currency.
          value: amount, // The donation amount.
        },
      },
    ],
  };

  //Create a new req obj using the PayPal SDK.
  const request = new paypal.orders.OrdersCreateRequest();
  request.body = requestBody;
  try {
    //Send the request to PayPal API to create the order
    const response = await client.execute(request);
    //send order ID back to the frontend to complete the payment
    res.status(200).json({ orderID: response.resuly.id });
  } catch (error) {
    console.error("Failed to create PayPal order:", error.message);
    res.status(500).json({error: "Failed to create PayPal order."});
  }
});

//This is the route the frontend callls to capture the payment after the user approves it.
app.post("/capture-paypal-order", async (req, res) => {
  //We get the order ID from the frontend request body
  const { orderID } =req.body;
  //We create a new request object to capture the payment
  const request = new paypal.orders.OrdersCaptureRequest(orderID);
  try {
    //We send the capture request to PayPal's API
    const response = await client.execute(request);
    res.status(200).json({ status: "success", paymentDetails: response.result }); 
  } catch (error) {
    console.error("Failed to capture PayPal Order:", error.message);
    res.status(500).json({ error: "Failed tocapture PayPal order."});
  }
});


// We tell the Express app to start listening for incoming requests on the specified port.
app.listen(port, () => {
  console.log(`Server is listening at http://localhost:${port}`);
});

/*
//=== PayPal API Integration ===
const { PAYPAL_CLIENT_ID, PAYPAL_SECRET } = process.env;
//Function to generate an access token for PayPal API
async function generateAccessToken() {
  try {
    if (!PAYPAL_CLIENT_ID || !PAYPAL_SECRET) {
      throw new Error("MISSING_PAYPAL_CREDENTIALS");
    }
    const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString(
      "base64"
    );
    const response = await fetch(
      "https://api-m.sandbox.paypal.com/v1/oauth2/token",
      {
        method: "POST",
        body: "grant_type=client_credentials",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `PayPal token request failed: ${response.status} ${errorText}`
      );
    }

    const data = await response.json();
    return data.access_token;
  } catch (error) {
    console.error("Failed to generate PayPal Access Token:", error.message);
    return null;
  }
}

//Endpointbto create a PayPal order.
app.post("/paypal-order", async (req, res) => {
  try {
    const { amount } = req.body;
    const accessToken = await generateAccessToken();
    if (!accessToken) {
      return res.status(500).json({ error: "Could not generate access token" });
    }

    const response = await fetch(
      "https://api-m.sandbox.paypal.com/v2/checkout/orders",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          intent: "CAPTURE",
          purchase_units: [
            {
              amount: {
                currency_code: "USD",
                value: amount.toString(),
              },
            },
          ],
        }),
      }
    );

    const data = await response.json();
    if (!response.ok) {
      throw new Error(JSON.stringify(data));
    }
    res.status(200).json(data);
  } catch (error) {
    console.error("Failed to create PayPal order:", error.message);
    res.status(500).json({ error: "Failed to create PayPal order" });
  }
});

//Endpoint to capture PayPal Payment.
app.post("/paypal-capture/:orderID", async (req, res) => {
  try {
    const { orderID } = req.params;
    const accessToken = await generateAccessToken();
    if (!accessToken) {
      return res.status(500).json({ error: "Could not generate access token" });
    }

    const response = await fetch(
      `https://api-m.sandbox.paypal.com/v2/checkout/orders/${orderID}/capture`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );
    const data = await response.json();
    if (!response.ok) {
      throw new Error(JSON.stringify(data));
    }

    res.status(200).json(data);
  } catch (error) {
    console.error("Failed to capture PayPal payment:", error.message);
    res.status(500).json({ error: "Failed to capture PayPal payment" });
  }
});

*/
