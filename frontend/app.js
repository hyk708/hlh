document.addEventListener('DOMContentLoaded', () => {
    const inputSection = document.getElementById('input-section');
    const dashboardSection = document.getElementById('dashboard-section');

    const addressInput = document.getElementById('addressInput');
    const submitBtn = document.getElementById('submitBtn');
    
    const addressElement = document.getElementById('currentAddress');
    const detailsPanel = document.getElementById('details-panel');
    const detailsTitle = document.getElementById('details-title');
    const detailsContent = document.getElementById('details-content');
    const loadingOverlay = document.getElementById('loading');
    const backBtn = document.getElementById('backBtn');
    
    let network = null;

    submitBtn.addEventListener('click', () => {
        const address = addressInput.value.trim();
        if (/^0x[a-fA-F0-9]{40}$/.test(address)) {
            inputSection.classList.add('hidden');
            dashboardSection.classList.remove('hidden');
            runAnalysis(address);
        } else {
            alert('올바른 EVM 주소를 입력해주세요.(please input valid EVM address)');
        }
    });

    backBtn.addEventListener('click', () => {
        dashboardSection.classList.add('hidden');
        inputSection.classList.remove('hidden');
        addressInput.value = '';
        if (network) {
            network.destroy();
            network = null;
        }
    });

    async function runAnalysis(address) {
        addressElement.textContent = `${address.substring(0, 6)}...${address.substring(address.length - 4)}`;
        loadingOverlay.style.display = 'flex';
        loadingOverlay.innerHTML = `<div class="spinner"></div><p>활동 데이터 분석 중(Analyzing activity data)</p>`;
        detailsPanel.classList.add('details-panel-hidden');
        detailsTitle.textContent = '상세 정보(Detail Information)';
        detailsContent.innerHTML = '<p>노드를 클릭하여 상세 정보를 확인하세요.(click the node to view the detailed information)</p>';

        try {
            const response = await fetch(`http://localhost:3000/api/user-activity/${address}`);
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(`API 요청 실패(API request failed): ${errorData.detail || response.statusText}`);
            }
            const data = await response.json();
            
            loadingOverlay.innerHTML = `<div class="spinner"></div><p>LP 포지션 상세 정보 분석 중(Analyzing LP position detailed information)</p>`;
            const enrichedData = await enrichLPInfo(data);

            await renderGraph(enrichedData); 

        } catch (error) {
            console.error('데이터 로딩 중 에러(Error during data loading):', error);
            loadingOverlay.innerHTML = `<p style="color:red;">데이터를 불러오는 데 실패했습니다.(Failed to load data)<br>${error.message}</p>`;
        }
    }

    async function enrichLPInfo(data) {
        const { portfolio, interactions } = data;
        const lpCandidateNfts = portfolio.nfts.filter(nft => nft.name.toLowerCase().includes('position') || nft.name.toLowerCase().includes('pos'));
        const allTxHashesToFetch = [];
        lpCandidateNfts.forEach(nft => {
            const interaction = interactions.find(i => i.address.toLowerCase() === nft.contractAddress.toLowerCase());
            if (interaction && interaction.txHashes.length > 0) {
                allTxHashesToFetch.push(...interaction.txHashes);
            }
        });
        const uniqueTxHashes = [...new Set(allTxHashesToFetch)];
        const promises = uniqueTxHashes.map(txHash =>
            fetch(`http://localhost:3000/api/transaction-details/${txHash}`)
                .then(res => res.ok ? res.json() : null)
                .catch(() => null)
        );
        const results = await Promise.all(promises);
        results.forEach(detail => {
            if (detail && detail.isLpCreation) {
                const targetNft = portfolio.nfts.find(n => n.contractAddress.toLowerCase() === detail.to.hash.toLowerCase());
                if (targetNft) {
                    if (!targetNft.createdLpPools) targetNft.createdLpPools = [];
                    const token0 = portfolio.erc20Tokens.find(t => t.contractAddress.toLowerCase() === detail.lpInfo.token0.toLowerCase());
                    const token1 = portfolio.erc20Tokens.find(t => t.contractAddress.toLowerCase() === detail.lpInfo.token1.toLowerCase());
                    const newPool = {
                        token0Symbol: token0 ? token0.symbol : detail.lpInfo.token0.slice(0, 6),
                        token1Symbol: token1 ? token1.symbol : detail.lpInfo.token1.slice(0, 6),
                    };
                    const isDuplicate = targetNft.createdLpPools.some(p => p.token0Symbol === newPool.token0Symbol && p.token1Symbol === newPool.token1Symbol);
                    if (!isDuplicate) targetNft.createdLpPools.push(newPool);
                }
            }
        });
        return data;
    }

    async function renderGraph(data) {
        const { portfolio, interactions } = data;

        loadingOverlay.style.display = 'flex';
        loadingOverlay.innerHTML = `<div class="spinner"></div><p>상호작용한 컨트랙트 확인 중(Checking interacted contracts)</p>`;

        const uniqueInteractedAddresses = [...new Set(interactions.map(i => i.address))];

        const verificationPromises = uniqueInteractedAddresses.map(address =>
            fetch(`http://localhost:3000/api/token-info/${address}`)
                .then(res => res.json())
                .catch(() => ({ isToken: false, address }))
        );
        const verificationResults = await Promise.all(verificationPromises);

        const activeDeFiProjects = new Map();
        verificationResults.forEach(result => {
            if (result.isToken) {
                const interactionData = interactions.find(i => i.address.toLowerCase() === result.address.toLowerCase());
                if (interactionData) {
                    interactionData.name = result.name; 
                    activeDeFiProjects.set(interactionData.address, interactionData);
                }
            }
        });
        
        loadingOverlay.style.display = 'none';

        const nodes = new vis.DataSet();
        const edges = new vis.DataSet();

        nodes.add({
            id: 'user',
            label: `<b>User</b>\n${parseFloat(portfolio.nativeBalance).toFixed(4)} HYPE`,
            shape: 'dot',
            size: 30,
            color: '#007bff',
            font: { color: 'white', multi: 'html' }
        });

        activeDeFiProjects.forEach((interaction, projectAddress) => {
            nodes.add({
                id: projectAddress,
                label: interaction.name && interaction.name.length > 20 ? `${interaction.name.substring(0, 17)}...` : interaction.name,
                shape: 'database',
                color: '#17a2b8',
                size: 25
            });
            edges.add({
                from: 'user', to: projectAddress,
                label: `${interaction.txCount} txs`, arrows: 'to',
                color: { color: '#555' }
            });
        });

        const container = document.getElementById('network');
        const graphData = { nodes, edges };
        const options = {
            nodes: { size: 20, font: { color: '#ffffff' }, borderWidth: 2 },
            edges: { width: 1, color: { color: '#555' }, font: { color: '#a0a0a0', strokeWidth: 0 } },
            physics: { solver: 'forceAtlas2Based', forceAtlas2Based: { gravitationalConstant: -80, centralGravity: 0.01, springLength: 200, springConstant: 0.08 }, minVelocity: 0.75, stabilization: { iterations: 150 } },
            interaction: { tooltipDelay: 200, hideEdgesOnDrag: true }
        };
        
        network = new vis.Network(container, graphData, options);

        network.on('click', (params) => {
            if (params.nodes.length > 0) {
                const nodeId = params.nodes[0];
                detailsPanel.classList.remove('details-panel-hidden');
                
                if (nodeId === 'user') {
                    displayUserDetails(portfolio);
                } else {
                    const interactionData = activeDeFiProjects.get(nodeId);
                    displayInteractionDetails(interactionData);
                }
            } else {
                detailsPanel.classList.add('details-panel-hidden');
            }
        });
    }
    
    function displayUserDetails(portfolio) {
        detailsTitle.textContent = '내 자산 현황(My asset status)';
        let contentHTML = `<div class="token-item"><strong>HYPE (Native)</strong><p>${parseFloat(portfolio.nativeBalance).toFixed(6)}</p></div>`;
        contentHTML += `<h4>ERC-20 Tokens (${portfolio.erc20Tokens.length})</h4>`;
        if (portfolio.erc20Tokens.length > 0) {
            portfolio.erc20Tokens.forEach(token => {
                contentHTML += `<div class="token-item"><strong>${token.name} (${token.symbol})</strong><p>${parseFloat(token.balance).toFixed(6)}</p></div>`;
            });
        } else {
            contentHTML += `<p>보유한 ERC-20 토큰이 없습니다.(No ERC-20 tokens owned)</p>`;
        }
        contentHTML += `<h4>NFTs (${portfolio.nfts.length})</h4>`;
        if (portfolio.nfts.length > 0) {
            portfolio.nfts.forEach(nft => {
                contentHTML += `<div class="nft-item"><strong>${nft.name} (${nft.symbol})</strong>`;
                if (nft.createdLpPools && nft.createdLpPools.length > 0) {
                    contentHTML += `<p class="lp-title">Discovered LP Pools:</p><ul>`;
                    nft.createdLpPools.forEach(pool => {
                        contentHTML += `<li>${pool.token0Symbol} / ${pool.token1Symbol}</li>`;
                    });
                    contentHTML += `</ul>`;
                }
                contentHTML += `<p>보유 개수(Number of owned): ${nft.count}</p></div>`;
            });
        } else {
            contentHTML += `<p>보유한 NFT가 없습니다.(No NFTs owned)</p>`;
        }
        detailsContent.innerHTML = contentHTML;
    }

    function displayInteractionDetails(interaction) {
        detailsTitle.textContent = interaction.name;
        let contentHTML = `
            <p><strong>주소(Address):</strong> <span class="tx-hash">${interaction.address}</span></p>
            <p><strong>총 상호작용(Total interactions):</strong> ${interaction.txCount}회</p>
            <h4>호출된 함수(Called functions):</h4>
            <ul>${interaction.methods.map(method => `<li>${method}</li>`).join('')}</ul>
            <h4>관련 트랜잭션(Related transactions):</h4>
        `;
        interaction.txHashes.forEach(hash => {
            contentHTML += `<p class="tx-hash"><a href="https://www.hyperscan.com/tx/${hash}" target="_blank">${hash}</a></p>`;
        });
        detailsContent.innerHTML = contentHTML;
    }
});

