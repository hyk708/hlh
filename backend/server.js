require('dotenv').config();
const express = require('express');
const { ethers } = require('ethers');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const HYPERSCAN_URL = process.env.HYPERSCAN_URL;

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => { res.send('Point Farmer API is running!'); });

app.get('/api/user-activity/:address', async (req, res) => {
    try {
        const userAddress = req.params.address;
        console.log(`[ACTIVITY] Fetching all activity for ${userAddress}...`);

        if (!HYPERSCAN_URL) {
            throw new Error('.env 파일에 HYPERSCAN_URL을 설정해주세요(set HYPERSCAN_URL in /backend/.env)');
        }

        const [nativeBalance, portfolioResponse, txsResponse] = await Promise.all([
            provider.getBalance(userAddress),
            fetch(`${HYPERSCAN_URL}/addresses/${userAddress}/token-balances`),
            fetch(`${HYPERSCAN_URL}/addresses/${userAddress}/transactions`)
        ]);

        if (!portfolioResponse.ok) throw new Error(`Token Balances API Error: ${portfolioResponse.statusText}`);
        if (!txsResponse.ok) throw new Error(`Transactions API Error: ${txsResponse.statusText}`);

        const tokenBalances = await portfolioResponse.json();
        const transactions = await txsResponse.json();

        const portfolio = {
            nativeBalance: ethers.formatUnits(nativeBalance, 18),
            erc20Tokens: [],
            nfts: []
        };
        for (const item of tokenBalances) {
            if (item.token.type === 'ERC-20') {
                const decimals = parseInt(item.token.decimals || '18');
                portfolio.erc20Tokens.push({
                    contractAddress: item.token.address_hash,
                    name: item.token.name,
                    symbol: item.token.symbol,
                    balance: ethers.formatUnits(item.value, decimals)
                });
            } else if (item.token.type === 'ERC-721') {
                portfolio.nfts.push({
                    contractAddress: item.token.address_hash,
                    name: item.token.name,
                    symbol: item.token.symbol,
                    count: parseInt(item.value, 10)
                });
            }
        }
        console.log(`[ACTIVITY] Processed portfolio data.`);

        const interactions = {};
        for (const tx of transactions.items) {
            if (tx.from.hash.toLowerCase() !== userAddress.toLowerCase()) {
                continue;
            }
            
            if (tx.to) {
                const toAddress = tx.to.hash;
                if (!interactions[toAddress]) {
                    interactions[toAddress] = {
                        name: tx.to.name || toAddress,
                        methods: new Set(),
                        txCount: 0,
                        txHashes: []
                    };
                }
                interactions[toAddress].txCount++;
                if (tx.method) {
                    interactions[toAddress].methods.add(tx.method);
                }
                interactions[toAddress].txHashes.push(tx.hash);
            }
        }
        
        const finalInteractions = Object.entries(interactions).map(([address, data]) => ({
            address,
            name: data.name,
            methods: Array.from(data.methods),
            txCount: data.txCount,
            txHashes: data.txHashes
        }));

        console.log(`[ACTIVITY] Processed ${transactions.items.length} txs, found ${finalInteractions.length} interaction points.`);

        res.json({
            portfolio,
            interactions: finalInteractions
        });

    } catch (error) {
        console.error('Error fetching user activity:', error);
        res.status(500).json({ error: 'Failed to fetch user activity', detail: error.message });
    }
});

app.get('/api/transaction-details/:tx_hash', async (req, res) => {
    try {
        const { tx_hash } = req.params;
        console.log(`[TX_DETAIL] Fetching details for tx: ${tx_hash}`);

        const response = await fetch(`${HYPERSCAN_URL}/transactions/${tx_hash}`);
        if (!response.ok) throw new Error(`Transaction Detail API Error: ${response.statusText}`);
        
        const tx = await response.json();

        let lpInfo = null;
        if (tx.method === 'mint' && tx.decoded_input && tx.decoded_input.parameters.length > 0) {
            const params = tx.decoded_input.parameters[0].value;
            if (Array.isArray(params) && params.length >= 2 && ethers.isAddress(params[0]) && ethers.isAddress(params[1])) {
                lpInfo = {
                    token0: params[0],
                    token1: params[1],
                    details: params
                };
                console.log(`[TX_DETAIL] LP Pool creation detected. Tokens: ${lpInfo.token0}, ${lpInfo.token1}`);
            }
        }
        
        res.json({
            hash: tx.hash,
            to: tx.to,
            from: tx.from,
            method: tx.method,
            isLpCreation: !!lpInfo,
            lpInfo: lpInfo,
            fullTx: tx
        });

    } catch (error) {
        console.error('Error fetching transaction details:', error);
        res.status(500).json({ error: 'Failed to fetch transaction details', detail: error.message });
    }
});

app.get('/api/token-info/:address_hash', async (req, res) => {
    try {
        const { address_hash } = req.params;
        console.log(`[TOKEN_INFO] Checking if ${address_hash} is a token...`);

        const response = await fetch(`${HYPERSCAN_URL}/tokens/${address_hash}`);
        
        if (response.status === 404) {
            return res.json({ isToken: false, address: address_hash });
        }
        
        if (!response.ok) {
            throw new Error(`Token Info API Error: ${response.statusText}`);
        }
        
        const tokenInfo = await response.json();
        res.json({ isToken: true, address: address_hash, name: tokenInfo.name, symbol: tokenInfo.symbol });

    } catch (error) {
        console.error('Error fetching token info:', error);
        res.status(500).json({ error: 'Failed to fetch token info', detail: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
    console.log('Press Ctrl + C to stop the server.');
});

