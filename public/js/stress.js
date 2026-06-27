/**
 * stress.js - Handles Upload Stress Critical Index functionality
 */

(function () {
    'use strict';

    document.addEventListener('DOMContentLoaded', function () {
        initStressUpload();
    });

    function initStressUpload() {
        const submenuItems = document.querySelectorAll('.submenu-item');
        submenuItems.forEach(item => {
            if (item.textContent.trim().includes('Upload Stress Critical Index')) {
                item.addEventListener('click', function (e) {
                    e.preventDefault();
                    e.stopPropagation();
                    showStressUploadView();
                });
            }
        });

        const uploadBtn = document.getElementById('upload-stress-btn');
        if (uploadBtn) {
            uploadBtn.addEventListener('click', handleUploadClick);
        }
    }

    function showStressUploadView() {
        const allContainers = [
            'welcome-container',
            'default-task-table-container',
            'pc-task-table-container',
            'mc-task-table-container',
            'default-notification-table-container',
            'pc-notification-table-container',
            'mc-notification-table-container',
            'final-isometrics-table-container',
            'checker-view-container'
        ];
        allContainers.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = 'none';
        });

        const stressContainer = document.getElementById('stress-upload-container');
        if (stressContainer) stressContainer.style.display = 'block';

        const uploadBtnContainer = document.getElementById('stress-upload-button-container');
        if (uploadBtnContainer) uploadBtnContainer.style.display = 'block';
    }

    function handleUploadClick() {
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = '.xls,.xlsx';
        fileInput.style.display = 'none';

        fileInput.onchange = async function (e) {
            const file = e.target.files[0];
            if (!file) return;
            if (!window.confirm(`Upload "${file.name}" as stress critical index?`)) return;
            await uploadStressFile(file);
        };

        document.body.appendChild(fileInput);
        fileInput.click();
        document.body.removeChild(fileInput);
    }

    async function uploadStressFile(file) {
        const formData = new FormData();
        formData.append('stressFile', file);

        try {
            const response = await fetch('/api/upload-stress-data', {
                method: 'POST',
                body: formData
            });
            const data = await response.json();

            if (data.ok) {
                alert(`Upload successful! ${data.inserted || ''} lines loaded.`);
            } else {
                alert('Upload failed: ' + (data.error || 'Unknown error'));
            }
        } catch (error) {
            console.error('Upload error:', error);
            alert('Upload failed. Please try again.');
        }
    }

})();
