const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const path = require('path');
const axios = require('axios'); // Import axios
const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Firebase Admin SDK
admin.initializeApp({
    credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
    databaseURL: process.env.FIREBASE_DATABASE_URL,
});

const db = admin.database();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // Serve static files from the 'public' directory

// Login endpoint
app.post('/api/login', async (req, res) => {
    const { phoneNumber, pin } = req.body;

    try {
        const snapshot = await db.ref('users').orderByChild('phoneNumber').equalTo(phoneNumber).once('value');
        const users = snapshot.val();

        if (users) {
            let user = null;
            Object.keys(users).forEach(key => {
                if (users[key].pin === pin) {
                    user = { userId: key, ...users[key] };
                }
            });

            if (user) {
                res.json(user);
            } else {
                res.status(404).json({ message: 'Incorrect PIN or user not found' });
            }
        } else {
            res.status(404).json({ message: 'User not found' });
        }
    } catch (error) {
        res.status(500).json({ message: 'Error logging in', error });
    }
});

// Helper function to check for existing user details
const checkIfExists = async (phoneNumber, email, nin) => {
    const snapshot = await db.ref('users').once('value');
    const users = snapshot.val();

    for (const userId in users) {
        const user = users[userId];
        if (user.phoneNumber === phoneNumber || user.email === email || (nin && user.nin === nin)) {
            return true;
        }
    }
    return false;
};

// Register user endpoint
app.post('/api/register', async (req, res) => {
    const { phoneNumber, firstName, lastName, dob, nin, email, sponsorCode, pin } = req.body;

    try {
        // Check for existing user details
        const userExists = await checkIfExists(phoneNumber, email, nin);

        if (userExists) {
            return res.status(400).json({ message: 'Some of the credentials you provided are already registered. If you have registered previously, please log in to your account.' });
        }

        // Generate a unique 6-digit user ID
        const userId = Math.floor(100000 + Math.random() * 900000).toString();

        // Save user to the primary database (Firebase)
        await db.ref(`users/${userId}`).set({
            phoneNumber,
            firstName,
            lastName,
            dob,
            nin: nin || null,  // If NIN is not provided, set it as null
            email,
            sponsorCode,
            pin,
            balance: 0, // Set initial balance to 0
            cryptoBalance: 0, // Set initial crypto balance to 0
            monthlyCommission: 0, // Set initial monthly commission to 0
            kyc: 'Pending', // Set initial KYC status to Pending
            registeredAt: Date.now(), // Store the registration timestamp
            paymentMethods: {
                "Airtel Money": "",
                "MTN Mobile Money": "",
                "Chipper Cash": "",
                "Bank Transfer": "",
                "Crypto Transfer": ""
            } // Initialize paymentMethods with all options empty
        });

        // After creating the user in Firebase, send the userId to another database
        try {
            const secondaryResponse = await axios.post('https://upay-5iyy6inv7-sammyviks-projects.vercel.app/api/create-user', {
                userId: userId,
            });

            if (secondaryResponse.data.userId) {
                // If a sponsor code was provided, add the referral relationship
                if (sponsorCode) {
                    try {
                        const sponsorSnapshot = await db.ref(`users/${sponsorCode}`).once('value');
                        if (sponsorSnapshot.exists()) {
                            // Add referral relationship in the secondary database
                            const referralResponse = await axios.post('https://upay-5iyy6inv7-sammyviks-projects.vercel.app/api/add-referral', {
                                userId: sponsorCode, // Sponsor's user ID
                                referralId: userId, // Newly registered user's ID
                            });

                            if (referralResponse.data.success) {
                                return res.json({ 
                                    message: 'User registered successfully, replicated in secondary database, and referral added', 
                                    userId: userId 
                                });
                            } else {
                                console.error('Referral addition failed in secondary database.');
                                return res.json({ 
                                    message: 'User registered successfully, replicated in secondary database, but referral addition failed', 
                                    userId: userId 
                                });
                            }
                        } else {
                            console.error('Invalid sponsor code provided.');
                            return res.json({ 
                                message: 'User registered successfully, replicated in secondary database, but sponsor code invalid', 
                                userId: userId 
                            });
                        }
                    } catch (referralError) {
                        console.error('Error adding referral:', referralError);
                        return res.status(500).json({ 
                            message: 'User registered successfully, but referral addition failed', 
                            userId: userId 
                        });
                    }
                } else {
                    // No sponsor code was provided
                    return res.json({ 
                        message: 'User registered successfully and replicated in secondary database', 
                        userId: userId 
                    });
                }
            } else {
                // Handle failure from the secondary database
                return res.status(500).json({ 
                    message: 'User registered in the primary database, but failed in the secondary database', 
                    userId: userId 
                });
            }
        } catch (secondaryError) {
            console.error('Error creating user in secondary database:', secondaryError);
            return res.status(500).json({ 
                message: 'User registered in the primary database, but failed in the secondary database', 
                userId: userId 
            });
        }
    } catch (error) {
        console.error('Error registering user:', error);
        return res.status(500).json({ 
            message: 'Error registering user', 
            error 
        });
    }
});




// Update balance endpoint
app.patch('/api/update-balance', async (req, res) => {
    const { userId, balance } = req.body;

    if (!userId || balance === undefined) {
        return res.status(400).json({ message: 'User ID and balance are required' });
    }

    try {
        const userRef = db.ref(`users/${userId}`);
        const snapshot = await userRef.once('value');
        
        if (snapshot.exists()) {
            await userRef.update({ balance: balance });
            res.json({ message: 'Balance updated successfully', newBalance: balance });
        } else {
            res.status(404).json({ message: 'User not found' });
        }
    } catch (error) {
        console.error('Error updating balance:', error); // Log the error
        res.status(500).json({ message: 'Error updating balance', error: error.message });
    }
});

// Update user details endpoint
app.patch('/api/update-user', async (req, res) => {
    const { userId, phoneNumber, firstName, lastName, dob, nin, email, sponsorCode, pin, kyc } = req.body;

    try {
        const userRef = db.ref(`users/${userId}`);
        const snapshot = await userRef.once('value');
        
        if (snapshot.exists()) {
            const updates = {};
            if (phoneNumber) updates.phoneNumber = phoneNumber;
            if (firstName) updates.firstName = firstName;
            if (lastName) updates.lastName = lastName;
            if (dob) updates.dob = dob;
            if (nin) updates.nin = nin;
            if (email) updates.email = email;
            if (sponsorCode) updates.sponsorCode = sponsorCode;
            if (pin) updates.pin = pin;
            if (kyc) updates.kyc = kyc;

            await userRef.update(updates);
            res.json({ message: 'User details updated successfully', updatedFields: updates });
        } else {
            res.status(404).json({ message: 'User not found' });
        }
    } catch (error) {
        res.status(500).json({ message: 'Error updating user details', error });
    }
});

// Fetch user details endpoint
app.get('/api/user-details/:userId', async (req, res) => {
    const { userId } = req.params;

    try {
        const userSnapshot = await db.ref(`users/${userId}`).once('value');

        if (userSnapshot.exists()) {
            const user = userSnapshot.val();

            // Fetch transactions
            const transactionsSnapshot = await db.ref(`users/${userId}/transactions`).once('value');
            const transactions = transactionsSnapshot.val() || {};

            // Convert transactions object to an array for easier handling
            const transactionList = Object.keys(transactions).map(key => ({
                transactionId: key,
                ...transactions[key],
            }));

            res.json({
                fullName: `${user.firstName} ${user.lastName}`,
                phoneNumber: user.phoneNumber,
                email: user.email,
                kyc: user.kyc,
                sponsorCode: user.sponsorCode,
                registeredAt: user.registeredAt, // Include the registration date
                paymentMethods: user.paymentMethods || {
                    "Airtel Money": "",
                    "MTN Mobile Money": "",
                    "Chipper Cash": "",
                    "Bank Transfer": "",
                    "Crypto Transfer": ""
                },
                transactions: transactionList, // Include transaction list
            });
        } else {
            res.status(404).json({ message: 'User not found' });
        }
    } catch (error) {
        res.status(500).json({ message: 'Error fetching user details', error });
    }
});



// Fetch user first name endpoint
app.get('/api/user-first-name/:userId', async (req, res) => {
    const { userId } = req.params;

    try {
        const snapshot = await db.ref(`users/${userId}`).once('value');
        
        if (snapshot.exists()) {
            const user = snapshot.val();
            res.json({
                firstName: user.firstName
            });
        } else {
            res.status(404).json({ message: 'User not found' });
        }
    } catch (error) {
        res.status(500).json({ message: 'Error fetching user details', error });
    }
});

// Fetch user balance endpoint
app.get('/api/user-balance/:userId', async (req, res) => {
    const { userId } = req.params;

    try {
        const snapshot = await db.ref(`users/${userId}`).once('value');
        
        if (snapshot.exists()) {
            const user = snapshot.val();
            res.json({
                balance: user.balance
            });
        } else {
            res.status(404).json({ message: 'User not found' });
        }
    } catch (error) {
        res.status(500).json({ message: 'Error fetching user balance', error });
    }
});

// Verify old PIN endpoint
app.post('/api/verify-pin', async (req, res) => {
    const { userId, pin } = req.body;

    try {
        const userRef = db.ref(`users/${userId}`);
        const snapshot = await userRef.once('value');

        if (snapshot.exists()) {
            const user = snapshot.val();
            if (user.pin === pin) {
                res.json({ valid: true });
            } else {
                res.json({ valid: false });
            }
        } else {
            res.status(404).json({ message: 'User not found' });
        }
    } catch (error) {
        res.status(500).json({ message: 'Error verifying PIN', error });
    }
});


// Update crypto balance endpoint
app.patch('/api/update-crypto-balance', async (req, res) => {
    const { userId, amount, from, to, reason } = req.body; // Changed 'cryptoBalance' to 'amount'

    if (!userId || amount === undefined) {
        return res.status(400).json({ message: 'User ID and amount are required' });
    }

    try {
        const userRef = db.ref(`users/${userId}`);
        const snapshot = await userRef.once('value');

        if (snapshot.exists()) {
            const user = snapshot.val();
            
            // Calculate the new crypto balance by adding the specified amount
            const newCryptoBalance = (user.cryptoBalance || 0) + amount;

            // Update the crypto balance in the database
            await userRef.update({ cryptoBalance: newCryptoBalance });

            // Create a unique transaction ID with 'NXS' prefix
            const transactionId = `NXS${Date.now()}`;
            const transactionLogRef = db.ref(`users/${userId}/transactions/${transactionId}`);

            // Create the transaction log entry to reflect the updated amount
            const transactionData = {
                timestamp: Date.now(),
                amount: amount, // Log the updated amount
            };

            // Include optional fields if provided
            if (from) transactionData.from = from;
            if (to) transactionData.to = to;
            if (reason) transactionData.reason = reason;

            // Save the transaction log
            await transactionLogRef.set(transactionData);

            // Respond with a success message and the updated amount
            res.json({ message: 'Amount updated successfully', amount: amount });
        } else {
            res.status(404).json({ message: 'User not found' });
        }
    } catch (error) {
        res.status(500).json({ message: 'Error updating crypto balance', error: error.message });
    }
});





// Fetch user crypto balance endpoint
app.get('/api/user-crypto-balance/:userId', async (req, res) => {
    const { userId } = req.params;

    try {
        const snapshot = await db.ref(`users/${userId}`).once('value');

        if (snapshot.exists()) {
            const user = snapshot.val();
            res.json({
                cryptoBalance: user.cryptoBalance
            });
        } else {
            res.status(404).json({ message: 'User not found' });
        }
    } catch (error) {
        res.status(500).json({ message: 'Error fetching user crypto balance', error });
    }
});




// Fetch user payment methods endpoint
app.get('/api/user-payment-methods/:userId', async (req, res) => {
    const { userId } = req.params;

    try {
        const snapshot = await db.ref(`users/${userId}`).once('value');

        if (snapshot.exists()) {
            const user = snapshot.val();
            res.json({
                paymentMethods: user.paymentMethods || {
                    "Airtel Money": "",
                    "MTN Mobile Money": "",
                    "Chipper Cash": "",
                    "Bank Transfer": "",
                    "Crypto Transfer": ""
                }
            });
        } else {
            res.status(404).json({ message: 'User not found' });
        }
    } catch (error) {
        res.status(500).json({ message: 'Error fetching user payment methods', error });
    }
});



// Update payment methods endpoint
app.patch('/api/update-payment-methods', async (req, res) => {
    const { userId, paymentMethods } = req.body;

    // Ensure user ID and payment methods are provided
    if (!userId || typeof paymentMethods !== 'object') {
        return res.status(400).json({ message: 'User ID and payment methods object are required' });
    }

    try {
        const userRef = db.ref(`users/${userId}`);
        const snapshot = await userRef.once('value');

        if (snapshot.exists()) {
            // Merge existing payment methods with new ones
            const existingPaymentMethods = snapshot.val().paymentMethods || {};
            const updatedPaymentMethods = { ...existingPaymentMethods, ...paymentMethods };

            // Update the user's payment methods
            await userRef.update({ paymentMethods: updatedPaymentMethods });
            res.json({ message: 'Payment methods updated successfully', updatedPaymentMethods });
        } else {
            res.status(404).json({ message: 'User not found' });
        }
    } catch (error) {
        res.status(500).json({ message: 'Error updating payment methods', error: error.message });
    }
});


app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
